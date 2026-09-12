import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-turnstile-api-"));
process.env.MIRROR_DATA_DIR = dir;

const [{ default: Fastify }, store, openai, { buildApp }] = await Promise.all([
  import("fastify"),
  import("../dist/store.js"),
  import("../dist/openai.js"),
  import("../dist/index.js"),
]);

const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
await openai.registerOpenAiRoutes(app);

test.after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function useSession(accountId, turnstileToken) {
  store.saveVerifiedSession(
    `session-token-for-${accountId}-long-enough`,
    accountId,
    `device-${accountId}`,
    turnstileToken,
  );
  store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
}

function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function assistantAddFrame(upstreamConversationId, messageId, text) {
  return {
    p: "",
    o: "add",
    v: {
      conversation_id: upstreamConversationId,
      message: {
        id: messageId,
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
      },
    },
  };
}

function stubBackendWithHeaders(accountId, sentHeaders = [], sentBodies = []) {
  let turn = 0;
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
    if (body) sentBodies.push({ pathname, body });
    if (init.headers) sentHeaders.push({ pathname, headers: init.headers });

    if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: accountId } });
    if (pathname.endsWith("/models")) return Response.json({ models: [{ slug: "gpt-4o" }] });
    if (pathname.endsWith("/conversation/init"))
      return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
    if (pathname.endsWith("/f/conversation/prepare")) return Response.json({ conduit_token: "conduit" });
    if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
      return Response.json({ prepare_token: "prepare", proofofwork: { required: false } });
    if (pathname.endsWith("/sentinel/chat-requirements/finalize")) {
      const finalizeBody = body ?? {};
      return Response.json({ token: "requirements", turnstileToken: finalizeBody.turnstile });
    }
    if (pathname.endsWith("/f/conversation")) {
      turn += 1;
      const frames = [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `assistant-${turn}`, `reply-${turn}`), "[DONE]"];
      return sseBody(frames);
    }
    throw new Error(`Unexpected test URL: ${url}`);
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

// ---------------------------------------------------------------------------
// Store & Session Turnstile tests
// ---------------------------------------------------------------------------

test("saveVerifiedSession saves and updates turnstileToken", () => {
  store.saveVerifiedSession("sess-tok-12345678901234567890", "acc-1", "dev-1", "ts-token-1");
  const session = store.getSession();
  assert.equal(session?.turnstileToken, "ts-token-1");

  store.setSessionTurnstileToken("ts-token-updated");
  assert.equal(store.getSession()?.turnstileToken, "ts-token-updated");

  store.setSessionTurnstileToken(null);
  assert.equal(store.getSession()?.turnstileToken, undefined);
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions Turnstile passthrough and automated retrieval
// ---------------------------------------------------------------------------

test("POST /v1/chat/completions forwards turnstile token from request header", async () => {
  useSession("turnstile-user-1");
  const sentHeaders = [];
  const sentBodies = [];
  await withFetch(
    stubBackendWithHeaders("turnstile-user-1", sentHeaders, sentBodies),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "openai-sentinel-turnstile-token": "custom-hdr-turnstile-123",
        },
        payload: {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      assert.equal(res.statusCode, 200, res.body);

      // Verify the turnstile token was forwarded to /finalize
      const finalizeCall = sentBodies.find((s) => s.pathname.endsWith("/sentinel/chat-requirements/finalize"));
      assert.ok(finalizeCall, "expected finalize call");
      assert.equal(finalizeCall.body.turnstile, "custom-hdr-turnstile-123");

      // Verify the turnstile token was forwarded in headers to /f/conversation
      const convCall = sentHeaders.find((s) => s.pathname.endsWith("/f/conversation"));
      assert.ok(convCall, "expected conversation call");
      assert.equal(convCall.headers["openai-sentinel-turnstile-token"], "custom-hdr-turnstile-123");
    },
  );
});

test("POST /v1/chat/completions forwards turnstile token from metadata.mirror_turnstile_token", async () => {
  useSession("turnstile-user-2");
  const sentHeaders = [];
  const sentBodies = [];
  await withFetch(
    stubBackendWithHeaders("turnstile-user-2", sentHeaders, sentBodies),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          metadata: {
            mirror_turnstile_token: "meta-turnstile-456",
          },
          messages: [{ role: "user", content: "hello" }],
        },
      });
      assert.equal(res.statusCode, 200, res.body);

      const finalizeCall = sentBodies.find((s) => s.pathname.endsWith("/sentinel/chat-requirements/finalize"));
      assert.ok(finalizeCall);
      assert.equal(finalizeCall.body.turnstile, "meta-turnstile-456");

      const convCall = sentHeaders.find((s) => s.pathname.endsWith("/f/conversation"));
      assert.ok(convCall);
      assert.equal(convCall.headers["openai-sentinel-turnstile-token"], "meta-turnstile-456");
    },
  );
});

test("POST /v1/chat/completions automatically persists resolved turnstile token to session", async () => {
  // Session starts without turnstileToken
  useSession("turnstile-user-3");
  assert.equal(store.getSession()?.turnstileToken, undefined);

  const sentHeaders = [];
  const sentBodies = [];
  await withFetch(
    stubBackendWithHeaders("turnstile-user-3", sentHeaders, sentBodies),
    async () => {
      // API call with header provides token; turn completion must persist it to session
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-turnstile-token": "retrieved-turnstile-token-789",
        },
        payload: {
          model: "auto",
          messages: [{ role: "user", content: "hello" }],
        },
      });
      assert.equal(res.statusCode, 200, res.body);

      // Verify that after the turn, store.getSession() has the turnstileToken saved!
      assert.equal(store.getSession()?.turnstileToken, "retrieved-turnstile-token-789");
    },
  );
});

test("POST /v1/chat/completions redacts turnstile tokens from response metadata", async () => {
  useSession("turnstile-redact-user");
  await withFetch(
    stubBackendWithHeaders("turnstile-redact-user"),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          metadata: {
            turnstile_token: "secret-token-1",
            mirror_turnstile_token: "secret-token-2",
            private: "false",
          },
          messages: [{ role: "user", content: "hello" }],
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();
      assert.equal(json.metadata?.turnstile_token, undefined);
      assert.equal(json.metadata?.mirror_turnstile_token, undefined);
    },
  );
});

test("POST /v1/responses redacts turnstile tokens from response metadata", async () => {
  useSession("turnstile-redact-responses-user");
  await withFetch(
    stubBackendWithHeaders("turnstile-redact-responses-user"),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "auto",
          metadata: {
            turnstile_token: "secret-token-1",
            mirror_turnstile_token: "secret-token-2",
            custom_key: "safe-value",
          },
          input: "hello",
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();
      assert.equal(json.metadata?.custom_key, "safe-value");
      assert.equal(json.metadata?.turnstile_token, undefined);
      assert.equal(json.metadata?.mirror_turnstile_token, undefined);
    },
  );
});
