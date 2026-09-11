import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-turnstile-test-"));
process.env.MIRROR_DATA_DIR = dir;

const [store, auth, { SetSessionBody, ChatBody }] = await Promise.all([
  import("../dist/store.js"),
  import("../dist/auth.js"),
  import("../dist/api-schemas.js"),
]);

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("saveVerifiedSession saves and retrieves turnstileToken", () => {
  store.clearSession();
  const session = store.saveVerifiedSession(
    "synthetic-session-token-for-testing-only-12345",
    "acc-test",
    "dev-test",
    "turnstile-tok-abc",
  );
  assert.equal(session.turnstileToken, "turnstile-tok-abc");

  const loaded = store.getSession();
  assert.equal(loaded?.turnstileToken, "turnstile-tok-abc");
  store.clearSession();
});

test("saveVerifiedSession does not carry over turnstileToken when accountId changes", () => {
  store.clearSession();
  store.saveVerifiedSession("token-account-1", "account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // New session for a different account without turnstile token
  store.saveVerifiedSession("token-account-2", "account-2", "device-2");
  assert.equal(store.getSession()?.accountId, "account-2");
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("saveVerifiedSession does not carry over turnstileToken when sessionToken changes", () => {
  store.clearSession();
  store.saveVerifiedSession("token-session-1", "account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // Different session token for same account
  store.saveVerifiedSession("token-session-2", "account-1", "device-1");
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("saveVerifiedSession preserves turnstileToken when updating the same session and account", () => {
  store.clearSession();
  store.saveVerifiedSession("token-session-1", "account-1", "device-1", "token-turnstile-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");

  // Same session token and account
  store.saveVerifiedSession("token-session-1", "account-1", "device-1");
  assert.equal(store.getSession()?.turnstileToken, "token-turnstile-1");
  store.clearSession();
});

test("setSessionTurnstileToken updates and clears turnstileToken in session", () => {
  store.clearSession();
  store.saveVerifiedSession("synthetic-session-token-for-testing-only-12345");
  assert.equal(store.getSession()?.turnstileToken, undefined);

  store.setSessionTurnstileToken("fresh-turnstile-token");
  assert.equal(store.getSession()?.turnstileToken, "fresh-turnstile-token");

  store.setSessionTurnstileToken(null);
  assert.equal(store.getSession()?.turnstileToken, undefined);
  store.clearSession();
});

test("getValidCredentials attaches turnstileToken when available in session", async () => {
  store.clearSession();
  const session = store.saveVerifiedSession(
    "synthetic-session-token-for-testing-only-12345",
    "acc-test",
    "dev-test",
    "valid-cred-turnstile",
  );
  // Set cached token so needsMint is false
  session.cachedAccessToken = "mock-access-token";
  session.cachedAccessTokenExpiresAt = Date.now() + 3_600_000;
  store.updateMintedToken("mock-access-token", Date.now() + 3_600_000, null);

  const creds = await auth.getValidCredentials();
  assert.equal(creds.turnstileToken, "valid-cred-turnstile");
  store.clearSession();
});

test("SetSessionBody validates optional turnstileToken", () => {
  const validWithout = SetSessionBody.parse({
    sessionToken: "synthetic-session-token-1234567890",
  });
  assert.equal(validWithout.turnstileToken, undefined);

  const validWith = SetSessionBody.parse({
    sessionToken: "synthetic-session-token-1234567890",
    turnstileToken: "turnstile-token-123",
  });
  assert.equal(validWith.turnstileToken, "turnstile-token-123");

  assert.throws(() => {
    SetSessionBody.parse({
      sessionToken: "synthetic-session-token-1234567890",
      turnstileToken: 12345,
    });
  });
});

test("ChatBody validates optional turnstileToken", () => {
  const valid = ChatBody.parse({
    prompt: "Hello world",
    turnstileToken: "turnstile-override-123",
  });
  assert.equal(valid.turnstileToken, "turnstile-override-123");
});
