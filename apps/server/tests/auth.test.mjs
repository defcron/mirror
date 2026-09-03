import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("concurrent credential refreshes share one rotating session mint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-auth-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?auth-test=${Date.now()}`);
  const auth = await import(`../dist/auth.js?auth-test=${Date.now()}`);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
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
        JSON.stringify({ accessToken: `header.${payload}.signature` }),
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
    rmSync(dir, { recursive: true, force: true });
  }
});
