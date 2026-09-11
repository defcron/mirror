import assert from "node:assert/strict";
import test from "node:test";
import {
  getCachedTurnstileToken,
  setCachedTurnstileToken,
  clearCachedTurnstileToken,
  decodeTurnstileConfig,
  solveTurnstileWithBrowser,
  resolveTurnstileToken,
} from "../dist/index.js";

// --- Cache tests -------------------------------------------------------------

test("turnstile cache returns null when empty", () => {
  clearCachedTurnstileToken();
  assert.equal(getCachedTurnstileToken(), null);
});

test("turnstile cache stores and retrieves a valid token", () => {
  clearCachedTurnstileToken();
  setCachedTurnstileToken("tok-1", 60_000, 1000);
  assert.equal(getCachedTurnstileToken(1050), "tok-1");
});

test("turnstile cache expires tokens past ttl", () => {
  clearCachedTurnstileToken();
  setCachedTurnstileToken("tok-expired", 100, 1000);
  assert.equal(getCachedTurnstileToken(1200), null);
  assert.equal(getCachedTurnstileToken(1300), null);
});

test("clearCachedTurnstileToken empties the cache", () => {
  setCachedTurnstileToken("tok-clear", 60_000, 1000);
  clearCachedTurnstileToken();
  assert.equal(getCachedTurnstileToken(1050), null);
});

// --- decodeTurnstileConfig tests --------------------------------------------

test("decodeTurnstileConfig returns null on missing or invalid hints", () => {
  assert.equal(decodeTurnstileConfig(null), null);
  assert.equal(decodeTurnstileConfig(undefined), null);
  assert.equal(decodeTurnstileConfig(""), null);
  assert.equal(decodeTurnstileConfig("not-a-marker"), null);
  assert.equal(decodeTurnstileConfig("gAAAAAB"), null);
  assert.equal(decodeTurnstileConfig("gAAAAABinvalid-base64!~rest"), null);
  assert.equal(decodeTurnstileConfig(`gAAAAAB${Buffer.from('{"not":"array"}').toString("base64")}~rest`), null);
});

test("decodeTurnstileConfig decodes a valid embedded array config", () => {
  const payload = [1, 2, "test", true];
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const result = decodeTurnstileConfig(`gAAAAAB${encoded}~tail`);
  assert.deepEqual(result, payload);
});

// --- solveTurnstileWithBrowser tests ----------------------------------------

test("solveTurnstileWithBrowser returns null when playwright cannot launch", async () => {
  clearCachedTurnstileToken();
  const dummyPw = { chromium: null };
  const res = await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(res, null);
});

test("solveTurnstileWithBrowser captures token from request headers", async () => {
  clearCachedTurnstileToken();
  let closed = false;
  let cookiesSet = [];
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies(c) { cookiesSet = c; },
              async newPage() {
                const listeners = {};
                return {
                  on(event, cb) { listeners[event] = cb; },
                  async goto() {
                    if (listeners.request) {
                      listeners.request({
                        headers: () => ({ "openai-sentinel-turnstile-token": "captured-hdr-tok" }),
                        postData: () => null,
                      });
                    }
                  },
                  async evaluate() { return null; },
                };
              },
            };
          },
          async close() { closed = true; },
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({
    playwright: dummyPw,
    sessionToken: "sess-123",
  });
  assert.equal(token, "captured-hdr-tok");
  assert.equal(closed, true);
  assert.equal(cookiesSet[0].value, "sess-123");
  assert.equal(getCachedTurnstileToken(), "captured-hdr-tok");
});

test("solveTurnstileWithBrowser captures token from post data json", async () => {
  clearCachedTurnstileToken();
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                const listeners = {};
                return {
                  on(event, cb) { listeners[event] = cb; },
                  async goto() {
                    if (listeners.request) {
                      listeners.request({
                        headers: () => ({}),
                        postData: () => JSON.stringify({ turnstile: "captured-post-tok" }),
                      });
                    }
                  },
                  async evaluate() { return null; },
                };
              },
            };
          },
          async close() {},
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(token, "captured-post-tok");
});

test("solveTurnstileWithBrowser captures token from response headers", async () => {
  clearCachedTurnstileToken();
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                const listeners = {};
                return {
                  on(event, cb) { listeners[event] = cb; },
                  async goto() {
                    if (listeners.response) {
                      listeners.response({
                        url: () => "https://chatgpt.com/backend-api/sentinel/req",
                        headers: () => ({ "openai-sentinel-turnstile-token": "captured-resp-tok" }),
                      });
                    }
                  },
                  async evaluate() { return null; },
                };
              },
            };
          },
          async close() {},
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(token, "captured-resp-tok");
});

test("solveTurnstileWithBrowser falls back to page DOM evaluation", async () => {
  clearCachedTurnstileToken();
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                return {
                  on() {},
                  async goto() {},
                  async evaluate(fn) {
                    // Simulate DOM returning token
                    return "dom-turnstile-tok";
                  },
                };
              },
            };
          },
          async close() {},
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(token, "dom-turnstile-tok");
});

test("solveTurnstileWithBrowser handles abort signal", async () => {
  clearCachedTurnstileToken();
  const controller = new AbortController();
  controller.abort();
  let closed = false;
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                return {
                  on() {},
                  async goto() { await new Promise(() => {}); },
                  async evaluate() { return null; },
                };
              },
            };
          },
          async close() { closed = true; },
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({ playwright: dummyPw, signal: controller.signal });
  assert.equal(token, null);
  assert.equal(closed, true);
});

test("solveTurnstileWithBrowser handles navigation error gracefully", async () => {
  clearCachedTurnstileToken();
  let closed = false;
  const dummyPw = {
    chromium: {
      async launch() {
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                return {
                  on() {},
                  async goto() { throw new Error("nav failed"); },
                };
              },
            };
          },
          async close() { closed = true; },
        };
      },
    },
  };

  const token = await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(token, null);
  assert.equal(closed, true);
});

// --- resolveTurnstileToken tests --------------------------------------------

test("resolveTurnstileToken prioritizes override token", async () => {
  clearCachedTurnstileToken();
  const res = await resolveTurnstileToken({
    required: true,
    overrideToken: "override-tok",
    credentialsToken: "cred-tok",
  });
  assert.equal(res, "override-tok");
});

test("resolveTurnstileToken uses credentials token if no override", async () => {
  clearCachedTurnstileToken();
  const res = await resolveTurnstileToken({
    required: true,
    credentialsToken: "cred-tok",
  });
  assert.equal(res, "cred-tok");
});

test("resolveTurnstileToken uses process.env.CHATGPT_TURNSTILE_TOKEN", async () => {
  clearCachedTurnstileToken();
  const prev = process.env.CHATGPT_TURNSTILE_TOKEN;
  try {
    process.env.CHATGPT_TURNSTILE_TOKEN = "env-tok";
    const res = await resolveTurnstileToken({ required: true });
    assert.equal(res, "env-tok");
  } finally {
    if (prev === undefined) delete process.env.CHATGPT_TURNSTILE_TOKEN;
    else process.env.CHATGPT_TURNSTILE_TOKEN = prev;
  }
});

test("resolveTurnstileToken uses process.env.MIRROR_TURNSTILE_TOKEN", async () => {
  clearCachedTurnstileToken();
  const prevChat = process.env.CHATGPT_TURNSTILE_TOKEN;
  const prevMirr = process.env.MIRROR_TURNSTILE_TOKEN;
  try {
    delete process.env.CHATGPT_TURNSTILE_TOKEN;
    process.env.MIRROR_TURNSTILE_TOKEN = "mirror-env-tok";
    const res = await resolveTurnstileToken({ required: true });
    assert.equal(res, "mirror-env-tok");
  } finally {
    if (prevChat === undefined) delete process.env.CHATGPT_TURNSTILE_TOKEN;
    else process.env.CHATGPT_TURNSTILE_TOKEN = prevChat;
    if (prevMirr === undefined) delete process.env.MIRROR_TURNSTILE_TOKEN;
    else process.env.MIRROR_TURNSTILE_TOKEN = prevMirr;
  }
});

test("resolveTurnstileToken reuses cached token", async () => {
  clearCachedTurnstileToken();
  setCachedTurnstileToken("cached-tok", 60_000);
  const res = await resolveTurnstileToken({ required: true });
  assert.equal(res, "cached-tok");
});

test("resolveTurnstileToken invokes custom solver", async () => {
  clearCachedTurnstileToken();
  let challengeSeen = null;
  const res = await resolveTurnstileToken({
    required: true,
    dx: "dx-val",
    frameUrl: "frame-val",
    solver: async (c) => {
      challengeSeen = c;
      return "solver-tok";
    },
  });
  assert.equal(res, "solver-tok");
  assert.deepEqual(challengeSeen, { required: true, dx: "dx-val", frameUrl: "frame-val" });
  assert.equal(getCachedTurnstileToken(), "solver-tok");
});

test("resolveTurnstileToken continues when custom solver throws", async () => {
  clearCachedTurnstileToken();
  const res = await resolveTurnstileToken({
    required: false,
    solver: async () => { throw new Error("solver crashed"); },
  });
  assert.equal(res, null);
});

test("resolveTurnstileToken returns null when not required and no token available", async () => {
  clearCachedTurnstileToken();
  const res = await resolveTurnstileToken({ required: false });
  assert.equal(res, null);
});

test("solveTurnstileWithBrowser preserves sandbox by default and enables when configured", async () => {
  clearCachedTurnstileToken();
  let seenArgs = null;
  const dummyPw = {
    chromium: {
      async launch(launchOpts) {
        seenArgs = launchOpts.args;
        return {
          async newContext() {
            return {
              async addCookies() {},
              async newPage() {
                return {
                  on() {},
                  async goto() {},
                  async evaluate() { return "token-sandbox-test"; },
                };
              },
            };
          },
          async close() {},
        };
      },
    },
  };

  // Default: no --no-sandbox or --disable-setuid-sandbox
  await solveTurnstileWithBrowser({ playwright: dummyPw });
  assert.equal(seenArgs.includes("--no-sandbox"), false);
  assert.equal(seenArgs.includes("--disable-setuid-sandbox"), false);
  assert.equal(seenArgs.includes("--disable-dev-shm-usage"), true);

  // Explicit noSandbox: true
  await solveTurnstileWithBrowser({ playwright: dummyPw, noSandbox: true });
  assert.equal(seenArgs.includes("--no-sandbox"), true);
  assert.equal(seenArgs.includes("--disable-setuid-sandbox"), true);

  // Custom args
  await solveTurnstileWithBrowser({ playwright: dummyPw, args: ["--custom-arg"] });
  assert.deepEqual(seenArgs, ["--custom-arg"]);
});

