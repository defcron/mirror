import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

// proxyWebSocketUpgrade constructs a real `ws` WebSocket pointed at the
// hardcoded upstream (wss://chatgpt.com/...) and a real WebSocketServer for
// the inbound upgrade. Neither is something a test should actually dial out
// to, so this file replaces the "ws" package itself with an in-memory fake
// (Node's --experimental-test-module-mocks `mock.module`) before proxy.js is
// ever imported, giving full deterministic control over both ends of the
// pipe: the pending-message queue, the open-flush, bidirectional forwarding,
// and the close/error cascade between the two sockets.
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.instances.push(this);
  }
  send(data, options) {
    this.sent.push({ data, options });
  }
  close(code, reason) {
    // Real ws sockets treat close() as idempotent once already closed/closing
    // (no re-emitted "close"); mirroring that matters here because proxy.ts's
    // own closeBoth() calls close() on *both* sides from *each* side's "close"
    // handler - without this guard two fakes that emit "close" synchronously
    // (unlike the real, asynchronous close handshake) would call each other
    // in an unbounded loop.
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }
  // test helpers, not part of the real ws API
  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }
}
for (const [name, value] of [["CONNECTING", 0], ["OPEN", 1], ["CLOSING", 2], ["CLOSED", 3]]) {
  FakeWebSocket[name] = value;
  FakeWebSocket.prototype[name] = value;
}
FakeWebSocket.instances = [];

class FakeWebSocketServer {
  constructor(opts) {
    this.opts = opts;
  }
  handleUpgrade(req, socket, head, cb) {
    const clientSocket = new FakeWebSocket("client-side");
    FakeWebSocket.instances.pop(); // this is the inbound client socket, not an "upstream" dial - don't count it as one
    clientSocket.readyState = FakeWebSocket.OPEN;
    FakeWebSocketServer.lastClientSocket = clientSocket;
    cb(clientSocket);
  }
}

mock.module("ws", {
  namedExports: {
    WebSocket: FakeWebSocket,
    WebSocketServer: FakeWebSocketServer,
  },
});

const dir = mkdtempSync(path.join(tmpdir(), "mirror-proxy-ws-"));
process.env.MIRROR_DATA_DIR = dir;
// security.js is imported by proxy.js internally via a plain (query-less)
// specifier no matter what query this test itself uses to import proxy.js -
// so to read the SAME per-process controlSecret proxy.js's own
// authorizedLocalRequest() checks against, this test must also import it
// via the plain specifier (the established pattern for this codebase's ESM
// module-instance-sharing gotcha; see auth.test.mjs/chat-service.test.mjs).
const security = await import("../dist/security.js");
const store = await import("../dist/store.js");
const proxy = await import("../dist/proxy.js");
test.describe("server / proxy-websocket", () => {
test.after(() => rmSync(dir, { recursive: true, force: true }));

function jwtWithExp(secondsFromNow) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

// Every test below that reaches a real websocket upgrade needs
// getValidCredentials() to succeed, which mints via a GET against
// /api/auth/session. This file never exercises any other fetch-driven
// codepath, so one blanket mock (never restored - this process/file is
// dedicated to these tests) is simpler than repeating it per test.
globalThis.fetch = async () => Response.json({ accessToken: jwtWithExp(3600) });

function controlCookieHeader() {
  return security.controlCookie().split(";")[0]; // "mirror_control=<secret>"
}

function makeReq(overrides = {}) {
  const req = new EventEmitter();
  Object.assign(req, {
    url: "/p1/ws/user/abc",
    headers: {
      host: "localhost:5555",
      cookie: controlCookieHeader(),
      ...overrides.headers,
    },
    ...overrides,
  });
  return req;
}

function makeSocket() {
  const socket = new EventEmitter();
  socket.written = [];
  socket.destroyed = false;
  socket.end = (data) => {
    socket.written.push(data);
  };
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

test("rejects the upgrade with 403 when the request is not authorized/allowed, and never touches ws at all", async () => {
  const req = makeReq({ headers: { host: "localhost:5555", cookie: "" /* no control cookie, no bearer token */ } });
  const socket = makeSocket();
  const before = FakeWebSocket.instances.length;
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  assert.equal(socket.written.length, 1);
  assert.match(socket.written[0], /^HTTP\/1\.1 403 Forbidden/);
  assert.equal(FakeWebSocket.instances.length, before, "an unauthorized upgrade must never dial upstream");
});

test("destroys the socket when credentials cannot be minted, before ever touching ws", async () => {
  store.clearSession();
  const req = makeReq();
  const socket = makeSocket();
  const before = FakeWebSocket.instances.length;
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  assert.equal(socket.destroyed, true);
  assert.equal(socket.written.length, 0);
  assert.equal(FakeWebSocket.instances.length, before);
});

test("proxies a full websocket session: queues pre-open messages, flushes on open, forwards both directions, and cascades close", async () => {
  store.saveVerifiedSession("ws-session-token", "ws-account", "ws-device");
  const req = makeReq();
  const socket = makeSocket();

  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  assert.equal(socket.written.length, 0, "an authorized upgrade must not write an HTTP error response");

  const upstreamSocket = FakeWebSocket.instances.at(-1);
  const clientSocket = FakeWebSocketServer.lastClientSocket;
  assert.equal(upstreamSocket.url, "wss://chatgpt.com/p1/ws/user/abc");
  assert.match(upstreamSocket.opts.headers.authorization, /^Bearer header\./);
  assert.equal(upstreamSocket.opts.headers["oai-device-id"], "ws-device");
  assert.equal(upstreamSocket.opts.headers["chatgpt-account-id"], "ws-account");
  assert.equal(upstreamSocket.opts.headers.cookie, "__Secure-next-auth.session-token=ws-session-token");

  // Client sends before upstream is open -> queued, not forwarded yet.
  clientSocket.emit("message", Buffer.from("hello-before-open"), false);
  assert.equal(upstreamSocket.sent.length, 0);

  upstreamSocket.simulateOpen();
  assert.equal(upstreamSocket.sent.length, 1, "queued message must flush once upstream opens");
  assert.equal(upstreamSocket.sent[0].data.toString(), "hello-before-open");

  // Post-open: forwarded immediately in both directions.
  clientSocket.emit("message", Buffer.from("hello-after-open"), false);
  assert.equal(upstreamSocket.sent.length, 2);

  const clientReceived = [];
  const originalSend = clientSocket.send.bind(clientSocket);
  clientSocket.send = (data, opts) => {
    clientReceived.push(data);
    originalSend(data, opts);
  };
  upstreamSocket.emit("message", Buffer.from("reply-from-upstream"), false);
  assert.equal(clientReceived.length, 1);
  assert.equal(clientReceived[0].toString(), "reply-from-upstream");

  // Closing either side cascades to the other.
  clientSocket.emit("close");
  assert.equal(upstreamSocket.readyState, FakeWebSocket.CLOSED);
});

test("closes both sockets once the pending queue exceeds the message-count limit", async () => {
  store.saveVerifiedSession("ws-session-token-2", "ws-account-2", "ws-device-2");
  const req = makeReq();
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  const clientSocket = FakeWebSocketServer.lastClientSocket;

  for (let i = 0; i < 101; i++) clientSocket.emit("message", Buffer.from(`m${i}`), false);
  assert.equal(clientSocket.closedWith.code, 1009);
  assert.equal(upstreamSocket.readyState, FakeWebSocket.CLOSED);
});

test("closes both sockets once the pending queue exceeds the byte limit", async () => {
  store.saveVerifiedSession("ws-session-token-3", "ws-account-3", "ws-device-3");
  const req = makeReq();
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  const clientSocket = FakeWebSocketServer.lastClientSocket;

  const big = Buffer.alloc(600 * 1024, 1);
  clientSocket.emit("message", big, true);
  assert.equal(clientSocket.closedWith, null, "a single message under the byte cap must stay queued");
  clientSocket.emit("message", big, true); // 1.2MB total > 1MB cap
  assert.equal(clientSocket.closedWith.code, 1009);
  assert.equal(upstreamSocket.readyState, FakeWebSocket.CLOSED);
});

test("an upstream error or unexpected-response destroys the raw socket", async () => {
  store.saveVerifiedSession("ws-session-token-4", "ws-account-4", "ws-device-4");
  const req = makeReq();
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  upstreamSocket.emit("error", new Error("upstream exploded"));
  assert.equal(socket.destroyed, true);
});

test("an unexpected-response from upstream also destroys the raw socket", async () => {
  store.saveVerifiedSession("ws-session-token-5", "ws-account-5", "ws-device-5");
  const req = makeReq();
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  upstreamSocket.emit("unexpected-response");
  assert.equal(socket.destroyed, true);
});

test("an upgrade request with no url falls back to the upstream root path", async () => {
  store.saveVerifiedSession("ws-session-token-6", "ws-account-6", "ws-device-6");
  const req = makeReq({ url: undefined });
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  assert.equal(upstreamSocket.url, "wss://chatgpt.com/");
});

test("closeBoth swallows an exception thrown by either socket's close() call, still attempting to close the other side", async () => {
  store.saveVerifiedSession("ws-session-token-7", "ws-account-7", "ws-device-7");
  const req = makeReq();
  const socket = makeSocket();
  await proxy.proxyWebSocketUpgrade(req, socket, Buffer.alloc(0));
  const upstreamSocket = FakeWebSocket.instances.at(-1);
  const clientSocket = FakeWebSocketServer.lastClientSocket;

  let upstreamCloseAttempted = false;
  clientSocket.close = () => { throw new Error("client close exploded"); };
  upstreamSocket.close = () => { upstreamCloseAttempted = true; throw new Error("upstream close exploded"); };

  assert.doesNotThrow(() => clientSocket.emit("error", new Error("client-side socket error")));
  assert.equal(upstreamCloseAttempted, true, "upstream close must still be attempted even though the client-side close() threw first");
});

test("pending websocket limits account for each supported RawData representation", async () => {
  store.saveVerifiedSession("ws-fixture", "ws-account", "ws-device");
  for (const data of ["text", new ArrayBuffer(4), [Buffer.from("one"), Buffer.from("two")]]) {
    await proxy.proxyWebSocketUpgrade(makeReq(), makeSocket(), Buffer.alloc(0));
    const upstream = FakeWebSocket.instances.at(-1);
    const client = FakeWebSocketServer.lastClientSocket;
    client.emit("message", data, true);
    assert.equal(upstream.sent.length, 0);
    upstream.simulateOpen();
    assert.equal(upstream.sent[0].data, data);
    client.close();
  }
});
});
