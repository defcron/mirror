import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { mock } from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-startup-"));
process.env.MIRROR_DATA_DIR = dir;
const { default: Fastify } = await import("fastify");
let app, listenOptions, checkEgress;
const timers = [];
let verified = false;
mock.module("fastify", { defaultExport: options => {
  app = Fastify(options);
  const listen = app.listen.bind(app);
  app.listen = async options => {
    assert.equal(verified, true, "egress must be verified before binding");
    listenOptions = options;
    // Always bind a private ephemeral test port, including for the defaults case.
    return listen({ port: 0, host: "127.0.0.1" });
  };
  return app;
} });
test.describe("server / startup", () => {
test.after(async () => { timers.forEach(clearInterval); await app?.close(); rmSync(dir, { recursive: true, force: true }); });

test("executable startup applies defaults, handles failed upgrades, and closes on egress loss", async t => {
  let egressLost = false;
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(String(url), "https://www.cloudflare.com/cdn-cgi/trace");
    if (egressLost) throw new Error("fixture egress loss");
    verified = true;
    return new Response("warp=on\n");
  });
  const interval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    const timer = interval(callback, ms, ...args);
    timers.push(timer);
    if (ms === 30_000) checkEgress = callback;
    return timer;
  });
  const originalArgv = process.argv;
  const originalPort = process.env.PORT;
  const originalHost = process.env.HOST;
  try {
    process.argv = [process.execPath, fileURLToPath(new URL("../dist/index.js", import.meta.url))];
    for (const explicit of [false, true]) {
      verified = false;
      egressLost = false;
      if (explicit) { process.env.PORT = "0"; process.env.HOST = "127.0.0.1"; }
      else { delete process.env.PORT; delete process.env.HOST; }
      await import(`../dist/index.js?startup=${explicit}`);
      assert.deepEqual(listenOptions, { port: explicit ? 0 : 8787, host: "127.0.0.1" });
      assert.equal(app.server.listening, true);
      const health = await app.inject({ url: "/api/health", headers: { host: "localhost" } });
      assert.equal(health.statusCode, 200);
      let destroyed = false;
      app.server.emit("upgrade", { get headers() { throw new Error("fixture upgrade failure"); } }, { destroy: () => { destroyed = true; } }, Buffer.alloc(0));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(destroyed, true);
      let exit;
      const exited = new Promise(resolve => { exit = resolve; });
      t.mock.method(process, "exit", code => { exit(code); });
      egressLost = true;
      checkEgress();
      assert.equal(await exited, 1);
      assert.equal(app.server.listening, false);
    }
  } finally {
    process.argv = originalArgv;
    if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
    if (originalHost === undefined) delete process.env.HOST; else process.env.HOST = originalHost;
  }
});
});
