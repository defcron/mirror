import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("credentials are encrypted and conversation continuity persists", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?test=${Date.now()}`);
  try {
    store.saveVerifiedSession("a-sensitive-session-token-value", "account-1", "device-1");
    assert.equal(store.getSession().sessionToken, "a-sensitive-session-token-value");
    assert.equal(readFileSync(path.join(dir, "mirror.db")).includes(Buffer.from("a-sensitive-session-token-value")), false);

    const conversation = store.createConversation({ model: "auto", gizmoId: "gizmo-1", title: "Test" });
    conversation.conversationId = "upstream-1";
    conversation.currentNodeId = "assistant-node-1";
    conversation.initialized = true;
    store.updateConversation(conversation);
    assert.equal(store.getConversation(conversation.id).currentNodeId, "assistant-node-1");

    const messages = [{ role: "user", content: "hello" }];
    const fingerprint = store.fingerprintMessages(messages);
    store.saveOpenAiMapping(fingerprint, conversation.id, "assistant-node-1");
    assert.deepEqual(store.getOpenAiMapping(fingerprint), { conversationId: conversation.id, currentNodeId: "assistant-node-1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
