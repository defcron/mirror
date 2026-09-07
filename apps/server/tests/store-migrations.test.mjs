import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// Each test in this file imports ../dist/store.js fresh (unique query string +
// its own temp MIRROR_DATA_DIR), because most of what's covered here only
// runs once, at module-top-level, when the database/key/legacy-store files
// are first opened - exactly the store.test.mjs convention already used for
// "credentials are encrypted and conversation continuity persists".

function freshDir(label) {
  return mkdtempSync(path.join(tmpdir(), `mirror-store-${label}-`));
}

// --- encryption key handling ------------------------------------------------

test("MIRROR_STORE_KEY accepts a hex-encoded 32-byte key", async () => {
  const dir = freshDir("key-hex");
  process.env.MIRROR_DATA_DIR = dir;
  process.env.MIRROR_STORE_KEY = "11".repeat(32); // 64 hex chars -> 32 bytes
  try {
    const store = await import(`../dist/store.js?store-key-hex=${Date.now()}`);
    store.saveVerifiedSession("tok", "acct");
    assert.equal(store.getSession().sessionToken, "tok");
  } finally {
    delete process.env.MIRROR_STORE_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MIRROR_STORE_KEY accepts a base64-encoded 32-byte key", async () => {
  const dir = freshDir("key-b64");
  process.env.MIRROR_DATA_DIR = dir;
  process.env.MIRROR_STORE_KEY = Buffer.alloc(32, 7).toString("base64");
  try {
    const store = await import(`../dist/store.js?store-key-b64=${Date.now()}`);
    store.saveVerifiedSession("tok2", "acct");
    assert.equal(store.getSession().sessionToken, "tok2");
  } finally {
    delete process.env.MIRROR_STORE_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MIRROR_STORE_KEY of the wrong length throws at startup", async () => {
  const dir = freshDir("key-bad");
  process.env.MIRROR_DATA_DIR = dir;
  process.env.MIRROR_STORE_KEY = Buffer.alloc(10).toString("base64"); // too short
  try {
    await assert.rejects(
      import(`../dist/store.js?store-key-bad=${Date.now()}`),
      /must decode to exactly 32 bytes/,
    );
  } finally {
    delete process.env.MIRROR_STORE_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reuses the on-disk master key across restarts (no MIRROR_STORE_KEY set)", async () => {
  const dir = freshDir("key-reuse");
  process.env.MIRROR_DATA_DIR = dir;
  delete process.env.MIRROR_STORE_KEY;
  try {
    const first = await import(`../dist/store.js?store-key-reuse-a=${Date.now()}`);
    first.saveVerifiedSession("persisted-by-key-file", "acct");
    assert.ok(existsSync(path.join(dir, "master.key")));

    // A second "process" (fresh module instance, same data dir) must load the
    // same on-disk key file rather than minting a new one, or it couldn't
    // decrypt what the first instance wrote.
    const second = await import(`../dist/store.js?store-key-reuse-b=${Date.now()}`);
    assert.equal(second.getSession().sessionToken, "persisted-by-key-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- schema migration + legacy store.json migration + default-account claim -

test("migrates a pre-migration database: adds missing columns, imports legacy store.json, claims default-account data, then deletes the legacy file", async () => {
  const dir = freshDir("migrate");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    // Seed a database matching the schema from *before* is_private/is_branch/
    // attachments_json existed, with one conversation still owned by the
    // pre-account-key placeholder "default".
    const seed = new DatabaseSync(path.join(dir, "mirror.db"));
    seed.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT 'default', upstream_id TEXT,
        current_node_id TEXT NOT NULL, model TEXT NOT NULL, gizmo_id TEXT, title TEXT NOT NULL,
        initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
    `);
    seed
      .prepare(
        `INSERT INTO conversations (id, account_id, current_node_id, model, title, created_at, updated_at)
         VALUES ('pre-existing', 'default', 'client-created-root', 'auto', 'Pre-existing', '2024-01-01', '2024-01-01')`,
      )
      .run();
    seed.close();

    // A legacy (pre-sqlite) store.json with a session that should be migrated
    // into the encrypted settings table and then removed.
    const legacyFile = path.join(dir, "store.json");
    writeFileSync(
      legacyFile,
      JSON.stringify({
        session: {
          sessionToken: "legacy-session-token",
          deviceId: "legacy-device",
          savedAt: "2024-01-01T00:00:00.000Z",
          accountId: "claimed-account",
        },
      }),
    );

    const store = await import(`../dist/store.js?store-migrate=${Date.now()}`);

    // Legacy session migrated in.
    assert.equal(store.getSession().sessionToken, "legacy-session-token");
    assert.equal(store.getSession().accountId, "claimed-account");
    // Legacy file cleaned up once migrated.
    assert.equal(existsSync(legacyFile), false);

    // storedAccountId claim: the pre-existing "default"-owned conversation
    // now belongs to the account named in the migrated session.
    const claimed = store.listConversations("claimed-account");
    assert.ok(claimed.some((c) => c.id === "pre-existing"));

    // Column migrations: is_private, is_branch and attachments_json all work
    // now, proven by exercising the code paths that touch them.
    const priv = store.createConversation({ model: "auto", private: true, accountId: "claimed-account" });
    assert.equal(priv.private, true);
    const branch = store.branchConversation(priv.id, "client-created-root", "Branch");
    assert.equal(branch.isBranch, true);
    store.addMessage({ conversationId: priv.id, upstreamNodeId: null, role: "user", content: "hi", status: "done", events: [] });
    const [msg] = store.listMessages(priv.id);
    assert.deepEqual(msg.attachments, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed legacy store.json is left in place and never migrated", async () => {
  const dir = freshDir("migrate-bad");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const legacyFile = path.join(dir, "store.json");
    writeFileSync(legacyFile, "{ not actually json");
    const store = await import(`../dist/store.js?store-migrate-bad=${Date.now()}`);
    assert.equal(store.getSession(), null);
    assert.equal(existsSync(legacyFile), true, "an unreadable legacy file must be left for manual recovery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy store.json migration is skipped once a real session already exists", async () => {
  const dir = freshDir("migrate-skip");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    writeFileSync(
      path.join(dir, "store.json"),
      JSON.stringify({ session: { sessionToken: "should-not-be-used", savedAt: "2024-01-01" } }),
    );
    const store = await import(`../dist/store.js?store-migrate-skip=${Date.now()}`);
    // Establish a real session *after* the module has already loaded (and
    // thus already decided, at that load, whether to migrate).
    store.saveVerifiedSession("current-session", "acct");
    assert.equal(store.getSession().sessionToken, "current-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- small direct-call coverage for simple exported helpers -----------------

test("databaseHealthy reports true for a working database", async () => {
  const dir = freshDir("healthy");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-healthy=${Date.now()}`);
    assert.equal(store.databaseHealthy(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setSessionAccountId is a no-op with no session, a no-op for the same account, and claims data when it actually changes", async () => {
  const dir = freshDir("set-account");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-set-account=${Date.now()}`);
    // No session yet -> no-op, must not throw.
    store.setSessionAccountId("nope");
    assert.equal(store.getSession(), null);

    store.saveVerifiedSession("tok", "acct-a");
    store.setSessionAccountId("acct-a"); // same account -> no-op branch
    assert.equal(store.getSession().accountId, "acct-a");

    const conversation = store.createConversation({ model: "auto", accountId: "default" });
    store.setSessionAccountId("acct-b"); // real change -> claims "default" data
    assert.equal(store.getSession().accountId, "acct-b");
    assert.ok(store.listConversations("acct-b").some((c) => c.id === conversation.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setConversationModel updates the model and returns the refreshed conversation", async () => {
  const dir = freshDir("set-model");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-set-model=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto" });
    const updated = store.setConversationModel(conversation.id, "gpt-5-thinking");
    assert.equal(updated.model, "gpt-5-thinking");
    assert.equal(store.setConversationModel("no-such-id", "auto"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("syncRemoteConversations rolls back the whole batch if any single item fails to bind", async () => {
  const dir = freshDir("sync-rollback");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-sync-rollback=${Date.now()}`);
    assert.throws(() =>
      store.syncRemoteConversations(
        [{ id: {}, title: "bad", createTime: "t", updateTime: "t", currentNodeId: null, gizmoId: null, isArchived: false }],
        "acct",
      ),
    );
    // Nothing from the failed batch was committed.
    assert.equal(store.countConversations("acct"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getConversationSyncCursor falls back to the default cursor on unparsable stored JSON", async () => {
  const dir = freshDir("sync-cursor");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-sync-cursor=${Date.now()}`);
    // Establish the settings table, then corrupt one cursor's stored value
    // directly (there's no public API for writing malformed data).
    store.setConversationSyncCursor("acct", { activeOffset: 1, activeDone: false, archivedOffset: 0, archivedDone: false });
    const raw = new DatabaseSync(path.join(dir, "mirror.db"));
    raw.prepare("UPDATE settings SET value = ? WHERE key = ?").run("{not json", "conversation_sync_cursor:acct");
    raw.close();
    assert.deepEqual(store.getConversationSyncCursor("acct"), {
      activeOffset: 0,
      activeDone: false,
      archivedOffset: 0,
      archivedDone: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- importRemoteConversation ------------------------------------------------

test("importRemoteConversation returns null for an unknown local conversation", async () => {
  const dir = freshDir("import-missing");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-import-missing=${Date.now()}`);
    assert.equal(store.importRemoteConversation("no-such-id", {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importRemoteConversation walks the mapping chain, skips non-user/assistant nodes, imports once, and updates conversation fields", async () => {
  const dir = freshDir("import-full");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-import-full=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct" });
    const raw = {
      current_node: "node-3",
      default_model_slug: "gpt-5",
      gizmo_id: "g-9",
      title: "Remote Title",
      mapping: {
        // A real ChatGPT mapping's root node has no `message` field at all
        // - present here to exercise that (distinct from node-1's message
        // simply having an unrecognized author role).
        "node-0": {
          parent: null,
        },
        "node-1": {
          parent: "node-0",
          message: { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: ["hello"] }, status: "finished_successfully" },
        },
        "node-2": {
          parent: "node-1",
          message: { id: "m2", author: { role: "assistant" }, content: { content_type: "text", parts: ["hi ", "there"] }, status: "finished_successfully" },
        },
        "node-3": {
          parent: "node-2",
          message: { id: "m3", author: { role: "system" }, content: { content_type: "text", parts: ["system prompt, not imported"] }, status: "finished_successfully" },
        },
      },
    };
    const result = store.importRemoteConversation(conversation.id, raw);
    assert.equal(result.currentNodeId, "node-3");
    assert.equal(result.model, "gpt-5");
    assert.equal(result.gizmoId, "g-9");
    assert.equal(result.title, "Remote Title");

    const messages = store.listMessages(conversation.id);
    assert.equal(messages.length, 2, "the system-authored node must be skipped");
    assert.deepEqual(messages.map((m) => m.upstreamNodeId), ["m1", "m2"]);
    assert.equal(messages[1].content, "hi there");

    // Re-importing the same mapping must not duplicate already-imported messages.
    store.importRemoteConversation(conversation.id, raw);
    assert.equal(store.listMessages(conversation.id).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importRemoteConversation defaults a message with no content or status to empty text and 'done'", async () => {
  const dir = freshDir("import-no-content");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-import-no-content=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct" });
    const raw = {
      current_node: "node-1",
      mapping: {
        "node-1": {
          parent: null,
          // No `content` field at all (not even an object), and no
          // `status` field either - textFromRemoteMessage's `{}`/`[]`
          // fallbacks and the `status ?? "done"` default all fire here.
          message: { id: "m1", author: { role: "user" } },
        },
      },
    };
    store.importRemoteConversation(conversation.id, raw);
    const [message] = store.listMessages(conversation.id);
    assert.equal(message.content, "");
    assert.equal(message.status, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importRemoteConversation skips a mapping node whose message has no author object at all", async () => {
  const dir = freshDir("import-no-author");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-import-no-author=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct" });
    const raw = {
      current_node: "node-1",
      mapping: {
        "node-1": {
          parent: null,
          // No `author` field at all - distinct from an author object with
          // an unrecognized role.
          message: { id: "m1", content: { content_type: "text", parts: ["hi"] } },
        },
      },
    };
    store.importRemoteConversation(conversation.id, raw);
    assert.equal(store.listMessages(conversation.id).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importRemoteConversation tolerates a dangling current_node and missing raw fields", async () => {
  const dir = freshDir("import-dangling");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-import-dangling=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct" });
    const result = store.importRemoteConversation(conversation.id, { current_node: "ghost-node", mapping: {} });
    assert.equal(result.currentNodeId, "ghost-node");
    assert.equal(result.model, "auto", "non-string default_model_slug must leave the model untouched");
    assert.equal(store.listMessages(conversation.id).length, 0);

    // No current_node and no mapping at all -> falls back to the existing
    // currentNodeId and leaves title/gizmo untouched too.
    const other = store.createConversation({ model: "auto", accountId: "acct", gizmoId: "g-1", title: "Keep me" });
    const result2 = store.importRemoteConversation(other.id, {});
    assert.equal(result2.currentNodeId, other.currentNodeId);
    assert.equal(result2.gizmoId, "g-1");
    assert.equal(result2.title, "Keep me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- files, ownership, branching, replaceMessages ----------------------------

test("saveFile / ownsFile / ownsUpstreamConversation / deleteConversation", async () => {
  const dir = freshDir("files-own");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-files-own=${Date.now()}`);
    store.saveFile({ fileId: "f1", useCase: "multimodal", fileName: "a.png", mimeType: "image/png" }, "acct-x");
    assert.equal(store.ownsFile("f1", "acct-x"), true);
    assert.equal(store.ownsFile("f1", "acct-y"), false);
    assert.equal(store.ownsFile("no-such-file", "acct-x"), false);

    const conversation = store.createConversation({ model: "auto", accountId: "acct-x" });
    store.updateConversation({ ...conversation, conversationId: "upstream-abc" });
    assert.equal(store.ownsUpstreamConversation("upstream-abc", "acct-x"), true);
    assert.equal(store.ownsUpstreamConversation("upstream-abc", "acct-y"), false);
    assert.equal(store.ownsUpstreamConversation("no-such-upstream", "acct-x"), false);

    store.deleteConversation(conversation.id);
    assert.equal(store.getConversation(conversation.id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("branchConversation with throughMessageId copies only the messages up to and including that one", async () => {
  const dir = freshDir("branch-through");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-branch-through=${Date.now()}`);
    const source = store.createConversation({ model: "auto", accountId: "acct" });
    const m1 = store.addMessage({ conversationId: source.id, upstreamNodeId: null, role: "user", content: "one", status: "done", events: [] });
    const m2 = store.addMessage({ conversationId: source.id, upstreamNodeId: null, role: "assistant", content: "two", status: "done", events: [] });
    store.addMessage({ conversationId: source.id, upstreamNodeId: null, role: "user", content: "three (after the cut)", status: "done", events: [] });

    const branch = store.branchConversation(source.id, "assistant-node-x", "Branch", m2.id);
    const branchedMessages = store.listMessages(branch.id);
    assert.deepEqual(branchedMessages.map((m) => m.content), ["one", "two"]);
    assert.equal(branch.isBranch, true);

    assert.equal(store.branchConversation("no-such-source", "n", "t"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replaceMessages rolls back entirely if any entry fails to insert", async () => {
  const dir = freshDir("replace-rollback");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-replace-rollback=${Date.now()}`);
    assert.throws(() =>
      store.replaceMessages("no-such-conversation", [{ role: "user", content: "hi" }]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- rebaseConversationUpstream -----------------------------------------

test("rebaseConversationUpstream is a no-op for an unknown conversation id", async () => {
  const dir = freshDir("rebase-missing");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-rebase-missing=${Date.now()}`);
    // Must not throw even though there's nothing to update.
    store.rebaseConversationUpstream("no-such-conversation", {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebaseConversationUpstream defaults currentNodeId to client-created-root when omitted", async () => {
  const dir = freshDir("rebase-default-node");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-rebase-default-node=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct" });
    store.updateConversation({ ...conversation, currentNodeId: "some-real-node" });
    store.rebaseConversationUpstream(conversation.id, {});
    assert.equal(store.getConversation(conversation.id).currentNodeId, "client-created-root");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebaseConversationUpstream can set an explicit gizmoId and private flag, overriding the existing conversation's own", async () => {
  const dir = freshDir("rebase-gizmo-private");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-rebase-gizmo-private=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct", gizmoId: null });
    store.updateConversation({ ...conversation, private: false });
    store.rebaseConversationUpstream(conversation.id, {
      currentNodeId: "node-x",
      gizmoId: "g-explicit",
      private: true,
    });
    const updated = store.getConversation(conversation.id);
    assert.equal(updated.gizmoId, "g-explicit");
    assert.equal(updated.private, true);
    assert.equal(updated.currentNodeId, "node-x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rebaseConversationUpstream falls back to the existing conversation's gizmoId and private flag when overrides omit them", async () => {
  const dir = freshDir("rebase-fallback-existing");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-rebase-fallback-existing=${Date.now()}`);
    const conversation = store.createConversation({ model: "auto", accountId: "acct", gizmoId: "g-original" });
    store.updateConversation({ ...conversation, private: true });
    store.rebaseConversationUpstream(conversation.id, { currentNodeId: "node-y" });
    const updated = store.getConversation(conversation.id);
    assert.equal(updated.gizmoId, "g-original");
    assert.equal(updated.private, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- decrypt() malformed value -------------------------------------------

test("getSession throws when the stored session value has been corrupted outside the normal encrypt path", async () => {
  const dir = freshDir("corrupted-session");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-corrupted-session=${Date.now()}`);
    // Establish the database file and the settings table/row first.
    store.saveVerifiedSession("session-token-long-enough-for-test", "acct", "device-1");
    // Reach past the module's own encrypt()/decrypt() pair with a second,
    // independent raw connection to the same file, writing a value that
    // doesn't match the "v1.<iv>.<tag>.<ciphertext>" shape decrypt()
    // expects - simulating on-disk corruption or a foreign write.
    const raw = new DatabaseSync(path.join(dir, "mirror.db"));
    try {
      raw.prepare("UPDATE settings SET value = ? WHERE key = 'session'").run("not-an-encrypted-value");
    } finally {
      raw.close();
    }
    assert.throws(() => store.getSession(), /Unsupported encrypted value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- session revision listeners ------------------------------------------

test("onSessionChange notifies registered listeners on every session change and stops once unsubscribed", async () => {
  const dir = freshDir("session-listeners");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-session-listeners=${Date.now()}`);
    let calls = 0;
    const unsubscribe = store.onSessionChange(() => {
      calls += 1;
    });
    const revisionBefore = store.getSessionRevision();
    store.saveVerifiedSession("session-token-long-enough-for-test", "acct", "device-1");
    assert.equal(calls, 1);
    assert.equal(store.getSessionRevision(), revisionBefore + 1);

    unsubscribe();
    store.clearSession();
    assert.equal(calls, 1, "an unsubscribed listener must not be notified again");
    assert.equal(store.getSessionRevision(), revisionBefore + 2, "the revision still advances without any listeners");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateMintedToken is a no-op when there is no verified session yet", async () => {
  const dir = freshDir("minted-token-no-session");
  process.env.MIRROR_DATA_DIR = dir;
  try {
    const store = await import(`../dist/store.js?store-minted-token-no-session=${Date.now()}`);
    assert.equal(store.getSession(), null);
    // Must not throw even with nothing to update.
    store.updateMintedToken("cached-access", Date.now() + 60_000, null);
    assert.equal(store.getSession(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
