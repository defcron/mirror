//! SQLite schema + migrations, a byte-for-byte port of `schema.ts`.
//! Append new migrations to `MIGRATIONS`; never edit a released one.
//! Version 0 is the legacy, unversioned SQLite schema.

use rusqlite::Connection;

type Migration = fn(&Connection) -> rusqlite::Result<()>;

const MIGRATIONS: &[Migration] = &[baseline];

pub fn database_schema_version_count() -> i64 {
    MIGRATIONS.len() as i64
}

fn baseline(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        r#"
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
        "#,
    )?;

    add_column_if_missing(
        db,
        "messages",
        "attachments_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        db,
        "conversations",
        "is_private",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    add_column_if_missing(
        db,
        "conversations",
        "is_branch",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    Ok(())
}

fn add_column_if_missing(
    db: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut stmt = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let has_column = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == column);
    if !has_column {
        db.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum MigrationError {
    #[error(
        "Unsupported database schema version; use a compatible Mirror release or restore a pre-upgrade backup."
    )]
    UnsupportedVersion,
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

pub fn database_schema_version(db: &Connection) -> rusqlite::Result<i64> {
    db.query_row("PRAGMA user_version", [], |row| row.get(0))
}

pub fn migrate_database(db: &mut Connection) -> Result<(), MigrationError> {
    let tx = db.transaction()?;
    let version = database_schema_version(&tx)?;
    let target = database_schema_version_count();
    if version > target || version < 0 {
        return Err(MigrationError::UnsupportedVersion);
    }
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
        migration(&tx)?;
        tx.execute_batch(&format!("PRAGMA user_version = {}", index + 1))?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_database(&mut conn).unwrap();
        conn
    }

    #[test]
    fn fresh_database_lands_on_the_latest_schema_version() {
        let conn = migrated_conn();
        assert_eq!(
            database_schema_version(&conn).unwrap(),
            database_schema_version_count()
        );
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate_database(&mut conn).unwrap();
        // Insert a row so a destructive re-run (e.g. an accidental DROP/CREATE
        // without IF NOT EXISTS) would be caught by data loss, not just an error.
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('k','v','t')",
            [],
        )
        .unwrap();
        migrate_database(&mut conn).unwrap();
        let value: String = conn
            .query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(value, "v");
    }

    #[test]
    fn all_expected_tables_exist_after_migration() {
        let conn = migrated_conn();
        for table in [
            "settings",
            "conversations",
            "messages",
            "openai_contexts",
            "openai_transcripts",
            "conversation_instructions",
            "files",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "expected table `{table}` to exist");
        }
    }

    #[test]
    fn foreign_keys_cascade_delete_messages_when_conversation_is_deleted() {
        let conn = migrated_conn();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute(
            "INSERT INTO conversations (id, current_node_id, model, title, created_at, updated_at) VALUES ('c1','n1','gpt','t','now','now')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES ('m1','c1','user','hi','done','now')",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM conversations WHERE id = 'c1'", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            count, 0,
            "ON DELETE CASCADE should have removed the message"
        );
    }

    #[test]
    fn rejects_a_schema_version_newer_than_this_binary_supports() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version = 999;").unwrap();
        assert!(matches!(
            migrate_database(&mut conn),
            Err(MigrationError::UnsupportedVersion)
        ));
    }

    #[test]
    fn column_backfill_is_idempotent_on_a_pre_existing_older_table_shape() {
        // Simulate a DB created before attachments_json/is_private/is_branch
        // existed, matching what a real upgrade from an old on-disk DB looks
        // like, and confirm the ALTER TABLE backfill runs exactly once.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, events_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT 'default', upstream_id TEXT, current_node_id TEXT NOT NULL, model TEXT NOT NULL, gizmo_id TEXT, title TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
        )
        .unwrap();
        migrate_database(&mut conn).unwrap();
        for (table, column) in [
            ("messages", "attachments_json"),
            ("conversations", "is_private"),
            ("conversations", "is_branch"),
        ] {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .unwrap();
            let has = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .unwrap()
                .filter_map(Result::ok)
                .any(|name| name == column);
            assert!(has, "expected {table}.{column} to have been backfilled");
        }
    }
}
