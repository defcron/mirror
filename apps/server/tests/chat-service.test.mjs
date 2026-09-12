import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// chat-service.js's own internal `import ... from "./store.js"` always
// resolves to the same (query-less) module instance regardless of what
// query string a test dynamically imports chat-service.js with itself, so
// a single shared store/chat-service pair (set up once, like
// reliability.test.mjs does) is what actually gives every test a
// consistent view of the same database and the same in-memory
// `activeTurns` map that stopConversation/the 409 guard depend on.
const dir = mkdtempSync(path.join(tmpdir(), "mirror-chat-service-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const service = await import("../dist/chat-service.js");
test.describe("server / chat-service", () => {
test.after(() => rmSync(dir, { recursive: true, force: true }));

function useSession(accountId) {
  store.saveVerifiedSession(`session-token-for-${accountId}-long-enough`, accountId, `device-${accountId}`);
  store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
}

function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${p}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function stubHappyBackend(accountId, bodies) {
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (init.body) bodies?.push({ pathname, body: JSON.parse(String(init.body)) });
    if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: accountId } });
    if (pathname.endsWith("/conversation/init"))
      return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
    if (pathname.startsWith("/backend-api/gizmos/")) return new Response("not found", { status: 404 });
    if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
      return Response.json({ prepare_token: "prepare", proofofwork: { required: false } });
    if (pathname.endsWith("/sentinel/chat-requirements/finalize")) return Response.json({ token: "requirements" });
    if (pathname.endsWith("/f/conversation")) {
      return sseBody([
        JSON.stringify({
          p: "",
          o: "add",
          v: {
            conversation_id: "upstream-1",
            message: { id: "assistant-1", author: { role: "assistant" }, content: { content_type: "text", parts: ["done"] }, status: "finished_successfully" },
          },
        }),
        "[DONE]",
      ]);
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };
}

test("ephemeral chat uses upstream temporary mode and leaves no local rows", async () => {
  useSession("account-ephemeral");
  const originalFetch = globalThis.fetch;
  const bodies = [];
  try {
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(store.countConversations("account-ephemeral"), 0, "one-shot writes no rows even while running");
      return stubHappyBackend("account-ephemeral", bodies)(url, init);
    };

    const result = await service.runChat({
      prompt: "hello",
      model: "auto",
      ephemeral: true,
    });
    assert.equal(result.result.text, "done");
    assert.equal(store.getConversation(result.conversation.id), null);
    const initBody = bodies.find((item) =>
      item.pathname.endsWith("/conversation/init"),
    )?.body;
    const sendBody = bodies.find((item) =>
      item.pathname.endsWith("/f/conversation"),
    )?.body;
    assert.equal(initBody.history_and_training_disabled, true);
    assert.equal(sendBody.history_and_training_disabled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a gizmo's bootstrap payload fetch failure is swallowed and the turn still completes", async () => {
  useSession("account-gizmo");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = stubHappyBackend("account-gizmo");
    const result = await service.runChat({ prompt: "hi", model: "auto", gizmoId: "g-123" });
    assert.equal(result.result.text, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runChat rejects a second concurrent turn on the same conversation with a 409", async () => {
  useSession("account-conflict");
  const originalFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const conversation = store.createConversation({ model: "auto", accountId: "account-conflict" });
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) {
        await gate; // block the first call inside the try block so the conversation stays "active"
        return Response.json({ account: { account_user_id: "account-conflict" } });
      }
      return stubHappyBackend("account-conflict")(url, init);
    };
    const first = service.runChat({ conversationId: conversation.id, prompt: "first", model: "auto" });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      service.runChat({ conversationId: conversation.id, prompt: "second", model: "auto" }),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /already running/);
        return true;
      },
    );
    release();
    await first;
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an aborted turn is recorded as stopped, not errored", async () => {
  useSession("account-abort");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "account-abort" } });
      if (pathname.endsWith("/conversation/init")) {
        if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
      }
      throw new Error(`Unexpected test URL during abort test: ${url}`);
    };
    const controller = new AbortController();
    controller.abort();
    let conversationId;
    try {
      await service.runChat({ prompt: "hi", model: "auto", signal: controller.signal });
      throw new Error("expected runChat to reject");
    } catch (error) {
      assert.equal(error.name, "AbortError");
      [{ id: conversationId }] = store.listConversations("account-abort");
    }
    const [assistantMessage] = store.listMessages(conversationId).filter((m) => m.role === "assistant");
    assert.equal(assistantMessage.status, "stopped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed turn (not aborted) is recorded as an error", async () => {
  useSession("account-fail");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "account-fail" } });
      if (pathname.endsWith("/conversation/init")) return new Response("server error", { status: 500 });
      throw new Error(`Unexpected test URL during failure test: ${url}`);
    };
    await assert.rejects(service.runChat({ prompt: "hi", model: "auto" }));
    const [conversation] = store.listConversations("account-fail");
    const [assistantMessage] = store.listMessages(conversation.id).filter((m) => m.role === "assistant");
    assert.equal(assistantMessage.status, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("stopConversation aborts a running turn and reports false once it's gone", async () => {
  useSession("account-stop");
  const originalFetch = globalThis.fetch;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const conversation = store.createConversation({ model: "auto", accountId: "account-stop" });
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) {
        await gate;
        if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return Response.json({ account: { account_user_id: "account-stop" } });
      }
      throw new Error(`Unexpected test URL during stop test: ${url}`);
    };
    const running = service.runChat({ conversationId: conversation.id, prompt: "hi", model: "auto" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(service.stopConversation(conversation.id), true);
    release();
    await assert.rejects(running);
    assert.equal(service.stopConversation(conversation.id), false);
    assert.equal(service.stopConversation("no-such-conversation"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runChat rejects with 404 when the given conversationId does not exist", async () => {
  useSession("account-missing-conv");
  await assert.rejects(
    service.runChat({ conversationId: "does-not-exist", prompt: "hi", model: "auto" }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /Conversation not found/);
      return true;
    },
  );
});

test("runChat rejects with 404 when the conversation belongs to a different account", async () => {
  const conversation = store.createConversation({ model: "auto", accountId: "account-owner" });
  useSession("account-intruder");
  await assert.rejects(
    service.runChat({ conversationId: conversation.id, prompt: "hi", model: "auto" }),
    (error) => {
      assert.equal(error.statusCode, 404);
      assert.match(error.message, /Conversation not found/);
      return true;
    },
  );
});

test("an ephemeral turn started with no verified session falls back to the 'default' account id before failing", async () => {
  // No useSession() call at all: getSession() returns null, so the
  // ephemeral conversation object's accountId ?? "default" fallback (and
  // the omitted `model` here also exercising `opts.model ?? "auto"`) both
  // fire before the call inevitably rejects at getValidCredentials().
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("should never reach the network with no valid session");
    };
    await assert.rejects(service.runChat({ prompt: "hi", ephemeral: true }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an ephemeral turn with a verified session that has no accountId also falls back to 'default'", async () => {
  // A verified session's accountId is optional (see saveVerifiedSession in
  // store.ts) - distinct from the previous test's "no session at all",
  // this covers getSession() returning a truthy session object whose own
  // .accountId is still undefined.
  store.saveVerifiedSession("session-token-no-account-ephemeral-long-enough", undefined, "device-no-account-ephemeral");
  store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "default" } });
      return stubHappyBackend("default")(url);
    };
    const result = await service.runChat({ prompt: "hi", model: "auto", ephemeral: true });
    assert.equal(result.conversation.accountId, "default");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a brand-new (non-ephemeral) turn with no model given defaults through init's intended_default_model_slug", async () => {
  useSession("account-default-model");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "account-default-model" } });
      if (pathname.endsWith("/conversation/init"))
        // default_model_slug omitted entirely (null once parsed) so the
        // middle fallback - intended_default_model_slug - is what resolves
        // conversation.model instead.
        return Response.json({
          intended_default_model_slug: "resolved-intended-model",
          limits_progress: [],
          blocked_features: [],
        });
      return stubHappyBackend("account-default-model")(url);
    };
    // model omitted entirely: exercises opts.model ?? "auto" too.
    const result = await service.runChat({ prompt: "hi" });
    assert.equal(result.conversation.model, "resolved-intended-model");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a brand-new turn with no model slug anywhere in init's response keeps the 'auto' placeholder", async () => {
  useSession("account-no-model-slug");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "account-no-model-slug" } });
      if (pathname.endsWith("/conversation/init"))
        return Response.json({ limits_progress: [], blocked_features: [] });
      return stubHappyBackend("account-no-model-slug")(url);
    };
    const result = await service.runChat({ prompt: "hi", model: "auto" });
    assert.equal(result.conversation.model, "auto");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an assistant reply with no text and no status is stored as empty content with the 'done' default status", async () => {
  useSession("account-empty-reply");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: "account-empty-reply" } });
      if (pathname.endsWith("/conversation/init"))
        return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
      if (pathname.startsWith("/backend-api/gizmos/")) return new Response("not found", { status: 404 });
      if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
        return Response.json({ prepare_token: "prepare", proofofwork: { required: false } });
      if (pathname.endsWith("/sentinel/chat-requirements/finalize")) return Response.json({ token: "requirements" });
      if (pathname.endsWith("/f/conversation")) {
        return sseBody([
          JSON.stringify({
            p: "",
            o: "add",
            v: {
              conversation_id: "upstream-empty",
              // No `status` field at all (the reducer's status getter
              // requires a string, so this yields null) and empty text (so
              // neither onDelta nor the final assistantTexts entry ever
              // produces a non-empty fullText).
              message: { id: "assistant-empty", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } },
            },
          }),
          "[DONE]",
        ]);
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };
    const result = await service.runChat({ prompt: "hi", model: "auto" });
    assert.equal(result.result.text, "");
    assert.equal(result.result.status, null);
    const [assistantMessage] = store
      .listMessages(result.conversation.id)
      .filter((m) => m.role === "assistant");
    assert.equal(assistantMessage.content, "");
    assert.equal(assistantMessage.status, "done");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
});
