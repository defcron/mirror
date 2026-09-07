import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// auth.js's own internal `import ... from "./store.js"` always resolves to
// the same (query-less) module instance no matter what query string a test
// dynamically imports auth.js itself with - so a single shared store/auth
// pair, set up once here (the same pattern reliability.test.mjs uses), is
// what actually gives every test in this file a consistent view of the
// same database, rather than each test's own re-imported "fresh" store
// silently talking to a different module instance than auth.js is using.
const dir = mkdtempSync(path.join(tmpdir(), "mirror-auth-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const auth = await import("../dist/auth.js");
test.after(() => rmSync(dir, { recursive: true, force: true }));

function jwtWithExp(secondsFromNow) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

test("concurrent credential refreshes share one rotating session mint", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    store.saveVerifiedSession(
      "original-session-token-long-enough",
      "account-1",
      "device-1",
    );
    globalThis.fetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(
        JSON.stringify({ accessToken: jwtWithExp(3600) }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie":
              "__Secure-next-auth.session-token=rotated-token; Path=/; Secure",
          },
        },
      );
    };
    const credentials = await Promise.all([
      auth.getValidCredentials(),
      auth.getValidCredentials(),
      auth.getValidCredentials(),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(
      credentials.map((item) => item.deviceId),
      ["device-1", "device-1", "device-1"],
    );
    assert.equal(store.getSession().sessionToken, "rotated-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getValidCredentials refuses to mint with no session configured", async () => {
  store.clearSession();
  await assert.rejects(auth.getValidCredentials(), (error) => {
    assert.equal(error.statusCode, 401);
    assert.match(error.message, /POST \/api\/session first/);
    return true;
  });
});

test("getValidCredentials returns an already-cached token with no network call", async () => {
  const originalFetch = globalThis.fetch;
  try {
    store.saveVerifiedSession("session-token-long-enough-value", "account-1", "device-2");
    store.updateMintedToken("still-fresh-token", Date.now() + 60 * 60 * 1000, null);
    globalThis.fetch = async () => {
      throw new Error("must not mint when the cached token is still fresh");
    };
    const creds = await auth.getValidCredentials();
    assert.equal(creds.accessToken, "still-fresh-token");
    assert.equal(creds.deviceId, "device-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getValidCredentials marks a rejected session token as a 401", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Force a re-mint: no cached token this time.
    store.saveVerifiedSession("session-token-long-enough-value-2", "account-1", "device-3");
    globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
    await assert.rejects(auth.getValidCredentials(), (error) => {
      assert.equal(error.statusCode, 401);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyCandidateSessionToken mints without touching the stored session", async () => {
  const originalFetch = globalThis.fetch;
  try {
    store.clearSession();
    globalThis.fetch = async () => Response.json({ accessToken: jwtWithExp(3600) });
    const result = await auth.verifyCandidateSessionToken("candidate-session-token");
    assert.equal(result.persistedSessionToken, "candidate-session-token");
    assert.equal(store.getSession(), null, "verification alone must not persist a session");
    assert.match(result.credentials.deviceId, /^[0-9a-f-]{36}$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verifyCandidateSessionToken reuses the prior device id and rotated token when available", async () => {
  const originalFetch = globalThis.fetch;
  try {
    store.saveVerifiedSession("existing-session-token-value", "account-1", "existing-device");
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accessToken: jwtWithExp(3600) }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "__Secure-next-auth.session-token=rotated-candidate; Path=/",
        },
      });
    const result = await auth.verifyCandidateSessionToken("new-candidate-token");
    assert.equal(result.credentials.deviceId, "existing-device");
    assert.equal(result.persistedSessionToken, "rotated-candidate");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
