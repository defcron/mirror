import assert from "node:assert/strict";
import test from "node:test";
import { classifyProtocolFailure, BackendApiError, SessionTokenInvalidError } from "../dist/index.js";

test.describe("protocol / drift classification", () => {
  test("classifies a SessionTokenInvalidError as an authentication challenge", () => {
    const result = classifyProtocolFailure(new SessionTokenInvalidError("fixture: session rejected"));
    assert.equal(result.category, "authentication-challenge");
  });

  test("classifies a 401/403 BackendApiError as an authentication challenge", () => {
    assert.equal(classifyProtocolFailure(new BackendApiError("denied", 401)).category, "authentication-challenge");
    assert.equal(classifyProtocolFailure(new BackendApiError("denied", 403)).category, "authentication-challenge");
  });

  test("classifies a turnstile/challenge message as an authentication challenge even without a status", () => {
    assert.equal(classifyProtocolFailure(new Error("turnstile token missing")).category, "authentication-challenge");
    assert.equal(classifyProtocolFailure(new Error("interactive challenge required")).category, "authentication-challenge");
  });

  test("classifies an interrupted stream as transport truncation", () => {
    const result = classifyProtocolFailure(new BackendApiError("Conversation stream interrupted before completion"));
    assert.equal(result.category, "transport-truncation");
  });

  test("classifies a stream error_code as a known upstream error, not a transport failure", () => {
    const result = classifyProtocolFailure(new BackendApiError("Conversation stream returned error_code=content_filter"));
    assert.equal(result.category, "known-upstream-error");
  });

  test("classifies an unrecognized response shape as unsupported-shape", () => {
    assert.equal(classifyProtocolFailure(new BackendApiError("Unsupported asset pointer")).category, "unsupported-shape");
    assert.equal(classifyProtocolFailure(new BackendApiError("GET /x returned non-object JSON")).category, "unsupported-shape");
    assert.equal(classifyProtocolFailure(new BackendApiError("Unsupported conversation response: no assistant node was received")).category, "unsupported-shape");
  });

  test("falls back to unknown for an ordinary failure and for a non-Error throw", () => {
    assert.equal(classifyProtocolFailure(new Error("ECONNRESET")).category, "unknown");
    assert.equal(classifyProtocolFailure("a plain string throw").category, "unknown");
  });
});
