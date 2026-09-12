import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test.describe("server / store", () => {
test("credentials are encrypted and conversation continuity persists", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?test=${Date.now()}`);
  try {
    store.saveVerifiedSession(
      "a-sensitive-session-token-value",
      "account-1",
      "device-1",
    );
    assert.equal(
      store.getSession().sessionToken,
      "a-sensitive-session-token-value",
    );
    assert.equal(
      readFileSync(path.join(dir, "mirror.db")).includes(
        Buffer.from("a-sensitive-session-token-value"),
      ),
      false,
    );

    const conversation = store.createConversation({
      model: "auto",
      gizmoId: "gizmo-1",
      title: "Test",
    });
    conversation.conversationId = "upstream-1";
    conversation.currentNodeId = "assistant-node-1";
    conversation.initialized = true;
    store.updateConversation(conversation);
    assert.equal(
      store.getConversation(conversation.id).currentNodeId,
      "assistant-node-1",
    );

    const instructionsHash = store.fingerprintValue([
      { role: "system", content: "be concise" },
    ]);
    store.saveOpenAiContext(conversation.id, instructionsHash);
    assert.equal(store.getOpenAiContext(conversation.id), instructionsHash);

    store.syncRemoteConversations(
      [
        {
          id: "upstream-1",
          title: "Remote title",
          createTime: conversation.createdAt,
          updateTime: new Date(Date.now() + 1_000).toISOString(),
          currentNodeId: "assistant-node-2",
          gizmoId: null,
          isArchived: false,
        },
      ],
      "default",
    );
    assert.equal(
      store.getConversation(conversation.id).currentNodeId,
      "assistant-node-2",
    );

    const branch = store.branchConversation(
      conversation.id,
      "assistant-node-1",
      "Branch",
    );
    assert.equal(branch.isBranch, true);
    store.syncRemoteConversations(
      [
        {
          id: "upstream-1",
          title: "Remote newer",
          createTime: conversation.createdAt,
          updateTime: new Date(Date.now() + 2_000).toISOString(),
          currentNodeId: "assistant-node-3",
          gizmoId: null,
          isArchived: false,
        },
      ],
      "default",
    );
    assert.equal(
      store.getConversation(branch.id).currentNodeId,
      "assistant-node-1",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRemoteConversations preserves assistant parent when upstream entry lacks current_node", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-sync-test-"));
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?case=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", title: "Test" });
    conversation.conversationId = "upstream-123";
    conversation.currentNodeId = "assistant-parent-1";
    store.updateConversation(conversation);

    // Sidebar refresh arrives with currentNodeId: null
    store.syncRemoteConversations(
      [
        {
          id: "upstream-123",
          title: "Test Updated",
          createTime: conversation.createdAt,
          updateTime: new Date().toISOString(),
          currentNodeId: null,
          gizmoId: null,
          isArchived: false,
        },
      ],
      "default",
    );

    const updated = store.getConversation(conversation.id);
    assert.equal(updated.currentNodeId, "assistant-parent-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});
