import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeTurnstileConfig,
  resolveTurnstileToken,
  solveTurnstileWithBrowser,
} from "../dist/index.js";

function browserFixture({ request, response, dom = null, executeDom = false, gotoError, contextError, closeError, onLaunch, onNewPage, onGoto } = {}) {
  let closed = false;
  let cookies = [];
  let launchOptions;
  let contextOptions;
  const playwright = { chromium: { async launch(options) {
    launchOptions = options;
    onLaunch?.();
    return {
      async newContext(options) {
        contextOptions = options;
        if (contextError) throw contextError;
        return {
          async addCookies(value) { cookies = value; },
          async newPage() {
            onNewPage?.();
            const listeners = {};
            return {
              on(name, callback) { listeners[name] = callback; },
              async goto() {
                onGoto?.();
                if (gotoError) throw gotoError;
                if (request) listeners.request?.(request);
                if (response) listeners.response?.(response);
              },
              async evaluate(fn) { return executeDom ? fn() : dom; },
            };
          },
        };
      },
      async close() { closed = true; if (closeError) throw closeError; },
    };
  } } };
  return { playwright, state: () => ({ closed, cookies, launchOptions, contextOptions }) };
}

test.describe("protocol / turnstile", () => {
test("turnstile resolution ignores absent and already-aborted challenges", async () => {
  assert.equal(await resolveTurnstileToken({ required: false, overrideToken: "unused" }), null);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await resolveTurnstileToken({ required: true, overrideToken: "unused", signal: controller.signal }), null);
});

test("turnstile resolution uses a fresh request override", async () => {
  assert.equal(await resolveTurnstileToken({ required: true, overrideToken: "fresh-token" }), "fresh-token");
});

test("turnstile resolution returns null without an explicit resolver", async () => {
  assert.equal(await resolveTurnstileToken({ required: true }), null);
});

test("turnstile resolution calls an injected resolver and detaches cancellation", async () => {
  const controller = new AbortController();
  let removed = false;
  const original = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => { removed = true; return original(...args); };
  let challenge;
  const result = await resolveTurnstileToken({
    required: true, dx: "dx", frameUrl: "frame", signal: controller.signal,
    solver(value) { challenge = value; return "solved"; },
  });
  assert.equal(result, "solved");
  assert.deepEqual(challenge, { required: true, dx: "dx", frameUrl: "frame" });
  assert.equal(removed, true);
});

test("turnstile resolution normalizes an empty resolver result", async () => {
  assert.equal(await resolveTurnstileToken({ required: true, solver: () => "" }), null);
  assert.equal(await resolveTurnstileToken({ required: true, solver: () => Promise.reject(new Error("unavailable")) }), null);
});

test("turnstile resolution aborts a pending resolver", async () => {
  const controller = new AbortController();
  const pending = resolveTurnstileToken({ required: true, signal: controller.signal, solver: () => new Promise(() => {}) });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("embedded Turnstile configuration decoding is defensive", () => {
  for (const value of [null, undefined, "", "no marker", "gAAAAAB", "gAAAAABbad!~tail", `gAAAAAB${Buffer.from('{"x":1}').toString("base64")}~tail`])
    assert.equal(decodeTurnstileConfig(value), null);
  const expected = [1, "two"];
  const encoded = Buffer.from(JSON.stringify(expected)).toString("base64").replace(/=+$/, "");
  assert.deepEqual(decodeTurnstileConfig(`prefix-gAAAAAB${encoded}~tail`), expected);
});

test("browser solver captures request headers with the authenticated browser context", async () => {
  const fixture = browserFixture({ request: {
    headers: () => ({ "openai-sentinel-turnstile-token": "header-token" }),
    postData: () => null,
  } });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright, origin: "https://example.com", sessionToken: "session", deviceId: "device", args: ["--custom"] }), "header-token");
  assert.equal(fixture.state().closed, true);
  assert.equal(fixture.state().cookies[0].value, "session");
  assert.equal(fixture.state().contextOptions.extraHTTPHeaders["oai-device-id"], "device");
  assert.deepEqual(fixture.state().launchOptions.args, ["--custom"]);
});

test("browser solver captures POST, response, and DOM tokens", async () => {
  let fixture = browserFixture({ request: { headers: () => ({}), postData: () => JSON.stringify({ turnstile: "post-token" }) } });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "post-token");
  fixture = browserFixture({ response: { headers: () => ({ "openai-sentinel-turnstile-token": "response-token" }) } });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "response-token");
  fixture = browserFixture({ dom: "dom-token" });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "dom-token");
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  try {
    globalThis.document = { querySelector: () => ({ value: "input-token" }) };
    globalThis.window = {};
    fixture = browserFixture({ executeDom: true });
    assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "input-token");
    globalThis.document = { querySelector: () => null };
    globalThis.window = { turnstile: { getResponse: () => "widget-token" } };
    assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "widget-token");
    globalThis.window = { turnstile: { getResponse: () => "" } };
    assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
    globalThis.document = { querySelector: () => { throw new Error("dom"); } };
    assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test("browser solver preserves sandboxing by default and only disables it explicitly", async () => {
  const fixture = browserFixture({ dom: "token" });
  await solveTurnstileWithBrowser({ playwright: fixture.playwright });
  assert.deepEqual(fixture.state().launchOptions.args, ["--disable-dev-shm-usage"]);
  await solveTurnstileWithBrowser({ playwright: fixture.playwright, noSandbox: true });
  assert.ok(fixture.state().launchOptions.args.includes("--no-sandbox"));
  const prior = process.env.MIRROR_TURNSTILE_NO_SANDBOX;
  process.env.MIRROR_TURNSTILE_NO_SANDBOX = "true";
  try {
    await solveTurnstileWithBrowser({ playwright: fixture.playwright });
    assert.ok(fixture.state().launchOptions.args.includes("--disable-setuid-sandbox"));
  } finally {
    if (prior === undefined) delete process.env.MIRROR_TURNSTILE_NO_SANDBOX;
    else process.env.MIRROR_TURNSTILE_NO_SANDBOX = prior;
  }
});

test("browser solver closes cleanly on aborts and browser failures", async () => {
  const preAborted = new AbortController();
  preAborted.abort();
  assert.equal(await solveTurnstileWithBrowser({ playwright: { chromium: null }, signal: preAborted.signal }), null);
  assert.equal(await solveTurnstileWithBrowser({ playwright: { chromium: null } }), null);
  assert.equal(await solveTurnstileWithBrowser({ playwright: { chromium: { launch: async () => { throw new Error("launch"); } } } }), null);
  let fixture = browserFixture({ gotoError: new Error("navigation") });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
  assert.equal(fixture.state().closed, true);
  fixture = browserFixture({ contextError: new Error("context") });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
  const duringLaunch = new AbortController();
  fixture = browserFixture({ onLaunch: () => duringLaunch.abort() });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright, signal: duringLaunch.signal }), null);
  assert.equal(fixture.state().closed, true);
  fixture = browserFixture({ dom: "token", closeError: new Error("close") });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), "token");
  fixture = browserFixture({ contextError: new Error("context"), closeError: new Error("close") });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
  fixture = browserFixture({
    request: { headers: () => { throw new Error("headers"); }, postData: () => null },
    response: { headers: () => { throw new Error("headers"); } },
  });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright }), null);
  const duringNavigation = new AbortController();
  fixture = browserFixture({ onGoto: () => duringNavigation.abort() });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright, signal: duringNavigation.signal }), null);
  const beforeNavigation = new AbortController();
  fixture = browserFixture({ onNewPage: () => beforeNavigation.abort() });
  assert.equal(await solveTurnstileWithBrowser({ playwright: fixture.playwright, signal: beforeNavigation.signal }), null);
});

test("required resolution falls back from a custom resolver to the browser solver", async () => {
  let browserOptions;
  const token = await resolveTurnstileToken({
    required: true, dx: "dx", frameUrl: "frame", sessionToken: "session", deviceId: "device",
    credentialsToken: null,
    solver: () => null,
    browserSolver: async options => { browserOptions = options; return "browser-token"; },
  });
  assert.equal(token, "browser-token");
  assert.deepEqual(browserOptions, { frameUrl: "frame", sessionToken: "session", deviceId: "device", dx: "dx", signal: undefined });
  assert.equal(await resolveTurnstileToken({ required: true, credentialsToken: "credential", browserSolver: async () => assert.fail() }), "credential");
});
});
