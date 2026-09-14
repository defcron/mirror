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

test("default system instructions are empty until set, are stored per account, and round-trip", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?test=${Date.now()}`);
  try {
    assert.equal(store.getDefaultSystemInstructions("default"), "");
    store.setDefaultSystemInstructions("default", "Always answer in metric.");
    assert.equal(store.getDefaultSystemInstructions("default"), "Always answer in metric.");
    // A different account's default is independent.
    assert.equal(store.getDefaultSystemInstructions("other-account"), "");
    store.setDefaultSystemInstructions("default", "Reply concisely.");
    assert.equal(store.getDefaultSystemInstructions("default"), "Reply concisely.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hotkeys are empty (defaults apply client-side) until overridden, are stored per account, and tolerate garbage", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?test=${Date.now()}`);
  try {
    assert.deepEqual(store.getHotkeys("default"), {});
    store.setHotkeys("default", { commandPalette: "mod+shift+p" });
    assert.deepEqual(store.getHotkeys("default"), { commandPalette: "mod+shift+p" });
    // A different account's overrides are independent.
    assert.deepEqual(store.getHotkeys("other-account"), {});
    store.setHotkeys("default", {});
    assert.deepEqual(store.getHotkeys("default"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hotkeys setting that isn't a JSON object (corrupted or hand-edited) is tolerated as no overrides, and non-string values inside a valid object are dropped", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-store-"));
  process.env.MIRROR_DATA_DIR = dir;
  const store = await import(`../dist/store.js?test=${Date.now()}`);
  const { DatabaseSync } = await import("node:sqlite");
  try {
    store.setDefaultSystemInstructions("placeholder", ""); // ensure the DB file/schema exists
    const raw = new DatabaseSync(path.join(dir, "mirror.db"));
    try {
      const now = new Date().toISOString();
      raw
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run("hotkeys:garbage-account", "not json at all", now);
      raw
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run("hotkeys:array-account", "[1,2,3]", now);
      raw
        .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
        .run(
          "hotkeys:mixed-account",
          JSON.stringify({ commandPalette: "mod+k", weird: 42 }),
          now,
        );
    } finally {
      raw.close();
    }
    assert.deepEqual(store.getHotkeys("garbage-account"), {});
    assert.deepEqual(store.getHotkeys("array-account"), {});
    assert.deepEqual(store.getHotkeys("mixed-account"), { commandPalette: "mod+k" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
});
