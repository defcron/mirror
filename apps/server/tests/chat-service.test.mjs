import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("ephemeral chat uses upstream temporary mode and leaves no local rows", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-chat-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?chat-test=${Date.now()}`);
  const service = await import(
    `../dist/chat-service.js?chat-test=${Date.now()}`
  );
  const originalFetch = globalThis.fetch;
  const bodies = [];
  try {
    store.saveVerifiedSession(
      "session-token-long-enough-for-test",
      "account-1",
      "device-1",
    );
    store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(store.countConversations("account-1"), 0, "one-shot writes no rows even while running");
      const pathname = new URL(String(url)).pathname;
      if (init.body)
        bodies.push({ pathname, body: JSON.parse(String(init.body)) });
      if (pathname.endsWith("/me"))
        return Response.json({ account: { account_user_id: "account-1" } });
      if (pathname.endsWith("/conversation/init"))
        return Response.json({
          default_model_slug: "model-a",
          limits_progress: [],
          blocked_features: [],
        });
      if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
        return Response.json({
          prepare_token: "prepare",
          proofofwork: { required: false },
        });
      if (pathname.endsWith("/sentinel/chat-requirements/finalize"))
        return Response.json({ token: "requirements" });
      if (pathname.endsWith("/f/conversation")) {
        const payloads = [
          JSON.stringify("v1"),
          JSON.stringify({
            p: "",
            o: "add",
            v: {
              conversation_id: "upstream-1",
              message: {
                id: "assistant-1",
                author: { role: "assistant" },
                content: { content_type: "text", parts: ["done"] },
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
    rmSync(dir, { recursive: true, force: true });
  }
});
