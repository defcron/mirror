import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Same BROWSER_TOKEN literal proxy.ts uses internally (not exported) - a
// syntactically valid, unsigned, non-secret placeholder JWT the client sees
// in place of the real backend-api access token.
const BROWSER_TOKEN =
  "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6Im1pcnJvci11c2VyIn0.";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-proxy-http-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const { proxyChatGpt } = await import("../dist/proxy.js");
test.after(() => rmSync(dir, { recursive: true, force: true }));

function jwtWithExp(secondsFromNow) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function useSession(accountId, { withAccountId = true } = {}) {
  store.saveVerifiedSession(
    `session-token-${accountId}`,
    withAccountId ? accountId : undefined,
    `device-${accountId}`,
  );
}

function makeReq({ url = "/backend-api/models", method = "GET", headers = {}, body } = {}) {
  return {
    method,
    url,
    protocol: "http",
    headers: { host: "localhost:5555", accept: "application/json", ...headers },
    body,
    raw: new EventEmitter(),
    log: { error() {} },
  };
}

function makeReply() {
  const raw = new EventEmitter();
  raw.writableEnded = undefined;
  raw.destroyed = false;
  const writes = [];
  let headWritten = null;
  raw.writeHead = (status, headers) => {
    headWritten = { status, headers };
  };
  raw.write = (buf) => {
    writes.push(Buffer.isBuffer(buf) ? buf.toString() : String(buf));
    return true;
  };
  raw.end = (data) => {
    if (data !== undefined) writes.push(Buffer.isBuffer(data) ? data.toString() : String(data));
    raw.writableEnded = true;
  };
  const state = { headers: {}, sentJson: undefined, sentCode: 200 };
  const reply = {
    raw,
    hijack() {},
    getHeader: (name) => state.headers[name],
    header(name, value) {
      state.headers[name] = value;
      return reply;
    },
    code(c) {
      state.sentCode = c;
      return reply;
    },
    send(body) {
      state.sentJson = body;
      return reply;
    },
  };
  return { reply, raw, writes, state, get headWritten() { return headWritten; } };
}

function fetchRouter(routes) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    for (const [matcher, handler] of routes) {
      if (typeof matcher === "string" ? u.pathname === matcher : matcher.test(u.pathname)) {
        return handler(u, init);
      }
    }
    throw new Error(`unexpected fetch to ${u.href}`);
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// --- /api/auth/session (mirrorAuthSession) ----------------------------------

test("GET /api/auth/session mirrors upstream /me into a NextAuth-shaped session, hiding the real token", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () =>
        Response.json({ account: { account_user_id: "acct-1" }, name: "Ada", email: "ada@example.com" })],
    ]),
    async () => {
      useSession("session-full");
      const req = makeReq({ url: "/api/auth/session" });
      const { reply, state } = makeReply();
      await proxyChatGpt(req, reply);
      assert.equal(state.headers["Cache-Control"], "no-store");
      assert.deepEqual(state.sentJson.user, {
        id: "acct-1",
        name: "Ada",
        email: "ada@example.com",
        image: null,
      });
      assert.equal(state.sentJson.accessToken, BROWSER_TOKEN);
      assert.equal(state.sentJson.authProvider, "mirror-session-token");
    },
  ));

test("GET /api/auth/session falls back to defaults when /me fails", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => new Response("nope", { status: 500 })],
    ]),
    async () => {
      useSession("session-me-fails");
      const req = makeReq({ url: "/api/auth/session" });
      const { reply, state } = makeReply();
      await proxyChatGpt(req, reply);
      assert.equal(state.sentJson.user.id, "mirror-user");
      assert.equal(state.sentJson.user.name, "ChatGPT user");
      assert.equal(state.sentJson.user.email, null);
    },
  ));

// --- backend-api account-id resolution --------------------------------------

test("backend-api requests resolve and cache the account id from /me when the session has none yet", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => Response.json({ account: { account_user_id: "resolved-acct" } })],
      [/\/backend-api\/models$/, (u, init) => {
        assert.equal(init.headers.get("chatgpt-account-id"), "resolved-acct");
        return Response.json({ models: [] }, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      useSession("no-account-yet", { withAccountId: false });
      const req = makeReq({ url: "/backend-api/models" });
      const { reply, raw, writes } = makeReply();
      await proxyChatGpt(req, reply);
      assert.equal(raw.writableEnded, true);
      assert.equal(store.getSession().accountId, "resolved-acct", "resolveAccountId must persist what it found");
      assert.deepEqual(JSON.parse(writes.join("")), { models: [] });
    },
  ));

test("backend-api requests fall back to the org id when account_user_id is missing", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => Response.json({ orgs: { data: [{ id: "org-1" }] } })],
      [/\/backend-api\/models$/, (u, init) => {
        assert.equal(init.headers.get("chatgpt-account-id"), "org-1");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      useSession("org-fallback", { withAccountId: false });
      await proxyChatGpt(makeReq({ url: "/backend-api/models" }), makeReply().reply);
      assert.equal(store.getSession().accountId, "org-1");
    },
  ));

test("a client-supplied chatgpt-account-id header is never overridden by the resolved account", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/models$/, (u, init) => {
        assert.equal(init.headers.get("chatgpt-account-id"), "client-chosen-workspace");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      useSession("has-account-already"); // session.accountId already set -> resolveAccountId won't even fetch /me
      const req = makeReq({
        url: "/backend-api/models",
        headers: { "chatgpt-account-id": "client-chosen-workspace" },
      });
      await proxyChatGpt(req, makeReply().reply);
    },
  ));

// --- error handling -----------------------------------------------------------

test("an upstream fetch failure responds 502 without ever hijacking the reply", () =>
  withFetch(
    async () => {
      throw new Error("network exploded");
    },
    async () => {
      // Deliberately not a /backend-api/ path and no session configured, so
      // this reaches the actual proxied fetch() (the one wrapped in
      // try/catch) directly, without first needing a credential mint call
      // that would itself hit this same throwing mock.
      const req = makeReq({ url: "/plain/whatever" });
      const { reply, state } = makeReply();
      await proxyChatGpt(req, reply);
      assert.equal(state.sentCode, 502);
      assert.deepEqual(state.sentJson, { error: "upstream_request_failed", path: "/plain/whatever" });
    },
  ));

// --- response header filtering + cache-control rules --------------------------

test("strips hop-by-hop/security headers, rewrites Location, forwards a hijacked set-cookie, and always clears alt-svc", () =>
  withFetch(
    fetchRouter([
      [/\/some\/path$/, () =>
        new Response("plain body", {
          status: 302,
          headers: {
            "content-type": "text/plain",
            "alt-svc": 'h3=":443"; ma=2592000',
            "content-encoding": "gzip",
            "content-length": "999",
            "content-security-policy": "default-src 'self'",
            "x-frame-options": "DENY",
            "transfer-encoding": "chunked",
            location: "https://chatgpt.com/somewhere/else",
            "x-custom-passthrough": "kept",
          },
        })],
    ]),
    async () => {
      const req = makeReq({ url: "/some/path", headers: { accept: "text/plain" } });
      const { reply, raw } = makeReplyCapturingHeaders();
      reply.getHeader = (name) => (name === "set-cookie" ? "session=abc" : undefined);
      await proxyChatGpt(req, reply);
      const headers = reply.__capturedHeaders;
      assert.equal(headers["content-encoding"], undefined);
      assert.equal(headers["content-length"], undefined);
      assert.equal(headers["content-security-policy"], undefined);
      assert.equal(headers["x-frame-options"], undefined);
      assert.equal(headers["transfer-encoding"], undefined);
      assert.equal(headers["x-custom-passthrough"], "kept");
      assert.equal(headers["location"], "http://localhost:5555/somewhere/else");
      assert.equal(headers["set-cookie"], "session=abc");
      assert.equal(headers["alt-svc"], "clear");
      assert.ok(raw.writableEnded);
    },
  ));

test("response headers: static /cdn/ assets default to a 5-minute public cache when upstream sends none", () =>
  withFetch(
    fetchRouter([
      [/\/cdn\/asset\.png$/, () => new Response("bytes", { headers: { "content-type": "image/png" } })],
    ]),
    async () => {
      const req = makeReq({ url: "/cdn/asset.png", headers: { accept: "*/*" } });
      const { reply } = makeReplyCapturingHeaders();
      await proxyChatGpt(req, reply);
      assert.equal(reply.__capturedHeaders["cache-control"], "public, max-age=300");
      assert.equal(reply.__capturedHeaders["alt-svc"], "clear");
    },
  ));

test("response headers: non-static, non-rewritten responses default to no-store when upstream sends no cache-control", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/binary$/, () => new Response("bytes", { headers: { "content-type": "application/octet-stream" } })],
    ]),
    async () => {
      const req = makeReq({ url: "/plain/binary", headers: { accept: "*/*" } });
      const { reply } = makeReplyCapturingHeaders();
      await proxyChatGpt(req, reply);
      assert.equal(reply.__capturedHeaders["cache-control"], "no-store");
    },
  ));

test("response headers: rewritten text always forces no-store even if upstream sent a long-lived cache-control", () =>
  withFetch(
    fetchRouter([
      [/\/assets\/app\.js$/, () =>
        new Response("console.log('hi')", {
          headers: { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" },
        })],
    ]),
    async () => {
      const req = makeReq({ url: "/assets/app.js", headers: { accept: "*/*" } });
      const { reply } = makeReplyCapturingHeaders();
      await proxyChatGpt(req, reply);
      assert.equal(reply.__capturedHeaders["cache-control"], "no-store");
    },
  ));

function makeReplyCapturingHeaders() {
  const { reply, raw, writes, state } = makeReply();
  reply.__capturedHeaders = null;
  const originalWriteHead = raw.writeHead;
  raw.writeHead = (status, headers) => {
    reply.__capturedHeaders = headers;
    originalWriteHead(status, headers);
  };
  return { reply, raw, writes, state };
}

// --- HTML rewriting -------------------------------------------------------------

test("HTML responses: rewrites chatgpt.com URLs, strips Datadog script tags, hides the real access token, and injects EARLY_PATCH after <head>", async () => {
  useSession("html-req");
  const token = jwtWithExp(3600);
  await withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: token })],
      [/^\/$/, () =>
        new Response(
          `<html><head><title>t</title></head><body><script src="https://static.chatgpt.com/foo/datadoghq-rum.js"></script><a href="https://chatgpt.com/c/1">${token}</a></body></html>`,
          { headers: { "content-type": "text/html" } },
        )],
    ]),
    async () => {
      const req = makeReq({ url: "/", headers: { accept: "text/html" } });
      const { reply, writes } = makeReply();
      await proxyChatGpt(req, reply);
      const html = writes.join("");
      assert.ok(!html.includes("datadoghq"), "Datadog script tag must be stripped");
      assert.ok(!html.includes(token), "the real access token must never reach the client");
      assert.ok(html.includes(BROWSER_TOKEN), "the placeholder browser token must be substituted in");
      assert.ok(html.includes("http://localhost:5555/c/1"), "chatgpt.com links must be rewritten to the proxy origin");
      assert.ok(html.indexOf("<head>") < html.indexOf("<title>"), "the patch must be injected immediately after <head>, before existing head content");
      assert.ok(html.indexOf("<title>") < html.indexOf("</head>"), "original head content must be preserved");
    },
  );
});

test("HTML responses with no <head> tag prepend the patch instead", () =>
  withFetch(
    fetchRouter([
      [/^\/bare$/, () => new Response(`<div>no head here</div>`, { headers: { "content-type": "text/html" } })],
    ]),
    async () => {
      // Note: accept intentionally isn't "text/html" here - that only
      // controls whether the real access token gets hunted-and-replaced in
      // the body (which needs a credential mint this test doesn't mock);
      // the HTML-rewrite/EARLY_PATCH-injection path itself is driven purely
      // by the *upstream response's* content-type, tested here regardless.
      const req = makeReq({ url: "/bare", headers: { accept: "*/*" } });
      const { reply, writes } = makeReply();
      await proxyChatGpt(req, reply);
      const html = writes.join("");
      assert.ok(html.startsWith("<script>"), "with no <head> tag, EARLY_PATCH must be prepended to the whole document");
      assert.ok(html.includes("<div>no head here</div>"), "the original body content must be preserved");
      assert.ok(html.indexOf("<script>") < html.indexOf("<div>"), "the injected patch must precede the original body content");
    },
  ));

// --- rewritable non-HTML content (JS/JSON/CSS) ----------------------------------

test("rewritable text content (e.g. application/javascript) gets URL-rewritten and has telemetry init disabled", () =>
  withFetch(
    fetchRouter([
      [/\/assets\/bundle\.js$/, () =>
        new Response(`fetch("https://chatgpt.com/backend-api/x"); dd.init({applicationId:"abc"});`, {
          headers: { "content-type": "application/javascript" },
        })],
    ]),
    async () => {
      const req = makeReq({ url: "/assets/bundle.js", headers: { accept: "*/*" } });
      const { reply, writes } = makeReply();
      await proxyChatGpt(req, reply);
      const text = writes.join("");
      assert.ok(text.includes("http://localhost:5555/backend-api/x"));
      assert.match(text, /false&&dd\.init\(\{applicationId:/);
    },
  ));

// --- request abort propagation --------------------------------------------------

test("an aborted client request aborts the in-flight upstream fetch", async () => {
  let capturedSignal;
  await withFetch(
    async (url, init) => {
      capturedSignal = init.signal;
      return new Promise(() => {}); // never resolves - only the abort matters
    },
    async () => {
      // A plain (non-/backend-api/) path so this never needs credential
      // minting - it's the abort propagation into the *upstream proxy fetch*
      // itself that's under test here, not auth.
      const req = makeReq({ url: "/plain/slow-path" });
      const { reply } = makeReply();
      const pending = proxyChatGpt(req, reply);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(capturedSignal.aborted, false);
      req.raw.emit("aborted");
      assert.equal(capturedSignal.aborted, true);
      void pending; // intentionally left pending; the mock fetch never resolves
    },
  );
});

test("the reply socket closing early (before the response finished writing) also aborts the upstream fetch", async () => {
  let capturedSignal;
  await withFetch(
    async (url, init) => {
      capturedSignal = init.signal;
      return new Promise(() => {});
    },
    async () => {
      const req = makeReq({ url: "/plain/slow-path-2" });
      const { reply, raw } = makeReply();
      const pending = proxyChatGpt(req, reply);
      await new Promise((resolve) => setImmediate(resolve));
      raw.writableEnded = false;
      raw.emit("close");
      assert.equal(capturedSignal.aborted, true);
      void pending;
    },
  );
});

// --- requestBody() -------------------------------------------------------------

test("requestBody: a non-GET/HEAD request whose body was already parsed into a plain object by Fastify's JSON parser gets JSON-stringified before forwarding upstream", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/echo-object$/, (u, init) => {
        assert.equal(init.body, JSON.stringify({ hello: "world" }));
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      const req = makeReq({ url: "/plain/echo-object", method: "POST", body: { hello: "world" } });
      await proxyChatGpt(req, makeReply().reply);
    },
  ));

test("requestBody: a non-GET/HEAD request whose body is already a raw string or Uint8Array is forwarded unchanged, not re-stringified", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/echo-string$/, (u, init) => {
        assert.equal(init.body, "raw-string-body");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
      [/\/plain\/echo-bytes$/, (u, init) => {
        assert.ok(init.body instanceof Uint8Array);
        assert.deepEqual([...init.body], [1, 2, 3]);
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      await proxyChatGpt(makeReq({ url: "/plain/echo-string", method: "POST", body: "raw-string-body" }), makeReply().reply);
      await proxyChatGpt(makeReq({ url: "/plain/echo-bytes", method: "POST", body: new Uint8Array([1, 2, 3]) }), makeReply().reply);
    },
  ));

// --- safeRequestHeaders(): array-valued headers + Referer rewriting -----------

test("safeRequestHeaders: a header that arrives as an array of values (as the IncomingHttpHeaders type allows for a repeated header) is joined into one comma-separated forwarded value", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/array-header$/, (u, init) => {
        assert.equal(init.headers.get("x-oai-custom"), "value-a, value-b");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      const req = makeReq({
        url: "/plain/array-header",
        headers: { "x-oai-custom": ["value-a", "value-b"] },
      });
      await proxyChatGpt(req, makeReply().reply);
    },
  ));

test("safeRequestHeaders: a Referer pointing at the proxy's own origin is rewritten to the real upstream host, preserving the path", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/referer-check$/, (u, init) => {
        assert.equal(init.headers.get("referer"), "https://chatgpt.com/c/deep-conversation-id");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      const req = makeReq({
        url: "/plain/referer-check",
        headers: { referer: "http://localhost:5555/c/deep-conversation-id" },
      });
      await proxyChatGpt(req, makeReply().reply);
    },
  ));

test("safeRequestHeaders: a Referer header that isn't a parseable URL falls back to the bare upstream origin", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/referer-garbage$/, (u, init) => {
        assert.equal(init.headers.get("referer"), "https://chatgpt.com/");
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      const req = makeReq({
        url: "/plain/referer-garbage",
        headers: { referer: "not a valid url at all" },
      });
      await proxyChatGpt(req, makeReply().reply);
    },
  ));

// --- resolveAccountId(): failure paths ------------------------------------------

test("resolveAccountId: a non-ok response from /backend-api/me resolves to no account id, so no chatgpt-account-id header is forwarded", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => new Response("nope", { status: 500 })],
      [/\/backend-api\/models$/, (u, init) => {
        assert.equal(init.headers.get("chatgpt-account-id"), null);
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      useSession("me-not-ok", { withAccountId: false });
      await proxyChatGpt(makeReq({ url: "/backend-api/models" }), makeReply().reply);
      assert.equal(store.getSession().accountId, undefined, "a failed /me lookup must not cache any account id");
    },
  ));

test("resolveAccountId: a thrown /backend-api/me request resolves to no account id without crashing the proxied request", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => { throw new Error("network exploded during account-id resolution"); }],
      [/\/backend-api\/models$/, (u, init) => {
        assert.equal(init.headers.get("chatgpt-account-id"), null);
        return Response.json({}, { headers: { "content-type": "application/json" } });
      }],
    ]),
    async () => {
      useSession("me-throws", { withAccountId: false });
      const { reply, raw } = makeReply();
      await proxyChatGpt(makeReq({ url: "/backend-api/models" }), reply);
      assert.equal(raw.writableEnded, true, "the outer request must still complete normally");
    },
  ));

// --- response processing edge cases ----------------------------------------------

test("response processing: an upstream response with no body and no Content-Type ends the reply immediately, defaulting the forwarded content-type to application/octet-stream", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/empty$/, () => new Response(null, { status: 204 })],
    ]),
    async () => {
      const req = makeReq({ url: "/plain/empty", headers: { accept: "*/*" } });
      const { reply, raw, writes } = makeReplyCapturingHeaders();
      await proxyChatGpt(req, reply);
      assert.equal(reply.__capturedHeaders["content-type"], "application/octet-stream");
      assert.equal(raw.writableEnded, true);
      assert.deepEqual(writes, []);
    },
  ));

test("proxyChatGpt: a request with no Accept header at all falls back to treating it as not wanting HTML", () =>
  withFetch(
    fetchRouter([
      [/\/plain\/no-accept$/, () => Response.json({ ok: true }, { headers: { "content-type": "application/json" } })],
    ]),
    async () => {
      const req = makeReq({ url: "/plain/no-accept", headers: { accept: undefined } });
      const { reply, writes } = makeReply();
      await proxyChatGpt(req, reply);
      assert.deepEqual(JSON.parse(writes.join("")), { ok: true });
    },
  ));
