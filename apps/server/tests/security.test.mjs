import assert from "node:assert/strict";
import test from "node:test";
import {
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  isLoopbackHostname,
  tokenMatches,
} from "../dist/security.js";

test("combines singular and plural API-key settings without empty-value precedence", () => {
  assert.deepEqual(
    configuredApiKeys({ MIRROR_API_KEY: "one", MIRROR_API_KEYS: "two, three" }),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    configuredApiKeys({ MIRROR_API_KEY: "one", MIRROR_API_KEYS: "" }),
    ["one"],
  );
});

test("accepts loopback hosts and rejects DNS-rebinding hostnames", () => {
  assert.equal(isLoopbackHostname("127.0.0.8"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isAllowedRequestHost("localhost:8799"), true);
  assert.equal(isAllowedRequestHost("127.0.0.1:8799"), true);
  assert.equal(isAllowedRequestHost("attacker.example:8799"), false);
  assert.equal(isAllowedRequestHost(undefined), false);
});

test("allows same-origin and configured development origins only", () => {
  assert.equal(
    isAllowedOrigin("http://127.0.0.1:8799", "127.0.0.1:8799"),
    true,
  );
  assert.equal(
    isAllowedOrigin("https://attacker.example", "127.0.0.1:8799"),
    false,
  );
  assert.equal(isAllowedOrigin(undefined, "127.0.0.1:8799"), true);
});

test("parses and compares bearer credentials", () => {
  assert.equal(bearerToken("Bearer secret"), "secret");
  assert.equal(tokenMatches("secret", ["other", "secret"]), true);
  assert.equal(tokenMatches("wrong", ["secret"]), false);
});
