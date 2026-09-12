import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test.describe("server / openai-edit-history", () => {
test("assistant history is immutable while user edits rebase and continue", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-openai-edit-"));
  const priorDataDir = process.env.MIRROR_DATA_DIR;
  process.env.MIRROR_DATA_DIR = dir;
  const originalFetch = globalThis.fetch;
  let app;
  const sent = [];
  let upstreamTurn = 0;

  try {
    const [{ default: Fastify }, store, { registerOpenAiRoutes }] =
      await Promise.all([
        import("fastify"),
        import("../dist/store.js"),
        import("../dist/openai.js"),
      ]);
    store.saveVerifiedSession(
      "session-token-long-enough-for-test",
      "account-1",
      "device-1",
    );
    store.updateMintedToken(
      "cached-access",
      Date.now() + 60 * 60 * 1000,
      null,
    );

    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      const body = init.body ? JSON.parse(String(init.body)) : null;
      if (pathname.endsWith("/me"))
        return Response.json({ account: { account_user_id: "account-1" } });
      if (pathname.endsWith("/conversation/init"))
        return Response.json({
          default_model_slug: "model-a",
          limits_progress: [],
          blocked_features: [],
        });
      if (pathname.endsWith("/f/conversation/prepare"))
        return Response.json({ conduit_token: "conduit" });
      if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
        return Response.json({
          prepare_token: "prepare",
          proofofwork: { required: false },
        });
      if (pathname.endsWith("/sentinel/chat-requirements/finalize"))
        return Response.json({ token: "requirements" });
      if (pathname.endsWith("/f/conversation")) {
        upstreamTurn += 1;
        sent.push(body);
        const payloads = [
          JSON.stringify("v1"),
          JSON.stringify({
            p: "",
            o: "add",
            v: {
              conversation_id:
                typeof body?.conversation_id === "string"
                  ? body.conversation_id
                  : `upstream-${upstreamTurn}`,
              message: {
                id: `assistant-${upstreamTurn}`,
                author: { role: "assistant" },
                content: {
                  content_type: "text",
                  parts: [`reply-${upstreamTurn}`],
                },
                status: "finished_successfully",
              },
            },
          }),
          "[DONE]",
        ];
        return new Response(
          payloads.map((payload) => `data: ${payload}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`Unexpected test URL: ${url}`);
    };

    app = Fastify();
    await registerOpenAiRoutes(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" },
        ],
      },
    });
    assert.equal(first.statusCode, 200, first.body);
    const conversationId = first.headers["x-mirror-conversation-id"];
    assert.equal(typeof conversationId, "string");
    assert.deepEqual(
      store.listMessages(conversationId).map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply-1" },
      ],
      "a first turn with system instructions must reload as logical messages, not its flattened wire prompt",
    );

    const rejectedAssistantEdit = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" },
          { role: "assistant", content: "edited reply" },
          { role: "user", content: "follow up" },
        ],
      },
    });
    assert.equal(rejectedAssistantEdit.statusCode, 400, rejectedAssistantEdit.body);
    assert.match(rejectedAssistantEdit.body, /Assistant messages are read-only/);
    assert.equal(sent.length, 1, "a rejected assistant edit must not reach upstream");
    assert.deepEqual(
      store.listMessages(conversationId).map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "reply-1" },
      ],
    );

    const rejectedAssistantRemoval = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" },
          { role: "user", content: "follow up without the assistant turn" },
        ],
      },
    });
    assert.equal(
      rejectedAssistantRemoval.statusCode,
      400,
      rejectedAssistantRemoval.body,
    );
    assert.match(rejectedAssistantRemoval.body, /Assistant messages are read-only/);
    assert.equal(sent.length, 1, "a rejected assistant removal must not reach upstream");

    const edited = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "edited hello" },
        ],
      },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.headers["x-mirror-conversation-id"], conversationId);
    assert.equal(
      sent[1].conversation_id,
      "upstream-1",
      "an edited user turn must branch inside the existing upstream conversation",
    );
    assert.equal(sent[1].parent_message_id, "client-created-root");
    assert.equal(
      sent[1].messages[0].content.parts[0],
      "edited hello",
      "a user edit must be replayed as one real user turn, not a flattened USER/ASSISTANT transcript",
    );
    assert.deepEqual(
      store.listMessages(conversationId).map(({ role, content }) => ({
        role,
        content,
      })),
      [
        { role: "user", content: "edited hello" },
        { role: "assistant", content: "reply-2" },
      ],
      "the synthetic transcript-seeding prompt must not leak into stored history",
    );
    assert.equal(store.getConversation(conversationId).conversationId, "upstream-1");

    const reloaded = store.listMessages(conversationId).map(
      ({ role, content }) => ({ role, content }),
    );
    const continued = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "system", content: "Be concise." },
          ...reloaded,
          { role: "user", content: "after reload" },
        ],
      },
    });
    assert.equal(continued.statusCode, 200, continued.body);
    assert.equal(continued.headers["x-mirror-conversation-id"], conversationId);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].conversation_id, "upstream-1");
    assert.equal(
      sent[2].messages[0].content.parts[0],
      "after reload",
      "the post-reload turn must continue upstream instead of replaying/rebasing the transcript",
    );

    const beforeSecondUserEdit = store.listMessages(conversationId);
    const editedSecondUser = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "edited hello" },
          { role: "assistant", content: "reply-2" },
          { role: "user", content: "edited after reload" },
        ],
      },
    });
    assert.equal(editedSecondUser.statusCode, 200, editedSecondUser.body);
    assert.equal(
      sent[3].parent_message_id,
      beforeSecondUserEdit[1].upstreamNodeId,
      "editing a later user turn must branch from its real preceding assistant node",
    );
    assert.equal(
      sent[3].messages[0].content.parts[0],
      "edited after reload",
      "a later user edit must also be one real user bubble",
    );
    const afterSecondUserEdit = store.listMessages(conversationId);
    assert.deepEqual(
      afterSecondUserEdit.slice(0, 2).map(({ id, upstreamNodeId }) => ({
        id,
        upstreamNodeId,
      })),
      beforeSecondUserEdit.slice(0, 2).map(({ id, upstreamNodeId }) => ({
        id,
        upstreamNodeId,
      })),
      "the unchanged real prefix must retain its upstream node ids",
    );

    const imported = store.createConversation({
      id: "legacy-imported-conversation",
      accountId: "account-1",
      model: "model-a",
    });
    imported.conversationId = "legacy-upstream";
    imported.currentNodeId = "legacy-assistant-node";
    imported.initialized = true;
    store.updateConversation(imported);
    store.addMessage({
      conversationId: imported.id,
      upstreamNodeId: "legacy-user-node",
      role: "user",
      content: "legacy question",
      status: "done",
      events: [],
    });
    store.addMessage({
      conversationId: imported.id,
      upstreamNodeId: "legacy-assistant-node",
      role: "assistant",
      content: "legacy answer",
      status: "done",
      events: [],
    });

    const editedLegacy = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "model-a",
        metadata: { conversation_id: imported.id },
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "edited legacy question" },
        ],
      },
    });
    assert.equal(editedLegacy.statusCode, 200, editedLegacy.body);
    assert.equal(
      editedLegacy.headers["x-mirror-conversation-id"],
      imported.id,
    );
    assert.equal(sent.at(-1).conversation_id, "legacy-upstream");
    assert.equal(sent.at(-1).parent_message_id, "client-created-root");
    assert.equal(
      store.getConversation(imported.id).conversationId,
      "legacy-upstream",
      "an edited legacy/imported conversation must rebase in place even when it predates transcript hashes",
    );
  } finally {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    if (priorDataDir === undefined) delete process.env.MIRROR_DATA_DIR;
    else process.env.MIRROR_DATA_DIR = priorDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
});
