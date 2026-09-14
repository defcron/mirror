import type { DatabaseSync } from "node:sqlite";

// Append migrations; never edit a migration after releasing it.
// Version 0 is the legacy, unversioned SQLite schema.
const migrations = [
  function baseline(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT 'default', upstream_id TEXT,
        current_node_id TEXT NOT NULL, model TEXT NOT NULL, gizmo_id TEXT, title TEXT NOT NULL,
        initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT, is_private INTEGER NOT NULL DEFAULT 0,
        is_branch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(account_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
      CREATE TABLE IF NOT EXISTS openai_contexts (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        instructions_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS openai_transcripts (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL, transcript_hash TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS openai_transcripts_hash_idx ON openai_transcripts(account_id, transcript_hash);
      CREATE TABLE IF NOT EXISTS conversation_instructions (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, messages_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    const messageColumns = db
      .prepare("PRAGMA table_info(messages)")
      .all() as Array<{ name: string }>;
    if (!messageColumns.some((column) => column.name === "attachments_json")) {
      db.exec(
        "ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
      );
    }
    const conversationColumns = db
      .prepare("PRAGMA table_info(conversations)")
      .all() as Array<{ name: string }>;
    if (!conversationColumns.some((column) => column.name === "is_private")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!conversationColumns.some((column) => column.name === "is_branch")) {
      db.exec(
        "ALTER TABLE conversations ADD COLUMN is_branch INTEGER NOT NULL DEFAULT 0",
      );
    }

  },
];

export const DATABASE_SCHEMA_VERSION = migrations.length;

export function databaseSchemaVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

export function migrateDatabase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = databaseSchemaVersion(db);
    if (version > DATABASE_SCHEMA_VERSION || version < 0) {
      throw new Error("Unsupported database schema version; use a compatible Mirror release or restore a pre-upgrade backup.");
    }
    for (let index = version; index < migrations.length; index++) {
      migrations[index](db);
      db.exec(`PRAGMA user_version = ${index + 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
