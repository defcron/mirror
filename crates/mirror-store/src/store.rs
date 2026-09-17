//! Persistence layer — port of `apps/server/src/store.ts`.
//!
//! The TS module keeps its connection, session-revision counter and change
//! listeners in module-level globals. Here they are owned by a [`Store`] that
//! callers share via `Arc`, which keeps the same behavior while making the
//! whole layer testable against an in-memory database.
//!
//! Only `settings.session` (and sealed asset tickets) are encrypted;
//! conversation and message content is stored in plaintext by design — it is
//! the account owner's own content, at the same trust level as any saved
//! document, not a credential.

use crate::crypto::{CryptoError, EncryptionKey};
use crate::schema::{MigrationError, migrate_database};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

const DEFAULT_SYSTEM_INSTRUCTIONS_KEY_PREFIX: &str = "default_system_instructions:";
const HOTKEYS_KEY_PREFIX: &str = "hotkeys:";
const SESSION_KEY: &str = "session";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Migration(#[from] MigrationError),
    #[error(transparent)]
    Crypto(#[from] CryptoError),
    #[error("stored session could not be decoded: {0}")]
    MalformedSession(String),
    /// Mirrors the TS `statusCode: 409` error from `assertSessionRevision`.
    #[error("Session changed; retry with the current account")]
    SessionChanged,
}

/// Mirrors `StoredSession`. Optional fields are omitted when absent so the
/// re-encrypted JSON matches what `JSON.stringify` produces for a value with
/// `undefined` properties.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct StoredSession {
    #[serde(rename = "sessionToken")]
    pub session_token: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "savedAt")]
    pub saved_at: String,
    #[serde(rename = "assetLinkGeneration", skip_serializing_if = "Option::is_none")]
    pub asset_link_generation: Option<String>,
    #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(rename = "cachedAccessToken", skip_serializing_if = "Option::is_none")]
    pub cached_access_token: Option<String>,
    #[serde(
        rename = "cachedAccessTokenExpiresAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub cached_access_token_expires_at: Option<i64>,
    #[serde(rename = "turnstileToken", skip_serializing_if = "Option::is_none")]
    pub turnstile_token: Option<String>,
    #[serde(
        rename = "turnstileTokenSavedAt",
        skip_serializing_if = "Option::is_none"
    )]
    pub turnstile_token_saved_at: Option<i64>,
}

pub struct Store {
    connection: Mutex<Connection>,
    key: EncryptionKey,
    session_revision: AtomicU64,
}

impl Store {
    /// Opens (or creates) the database at `path`, runs migrations, and
    /// performs the same crash-recovery sweep the TS module does at import
    /// time: any message left `streaming` by a previous process is marked
    /// `interrupted`, since no writer is still producing it.
    pub fn open(path: &Path, key: EncryptionKey) -> Result<Self, StoreError> {
        let mut connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        migrate_database(&mut connection)?;
        connection.execute(
            "UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'",
            [],
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            key,
            session_revision: AtomicU64::new(0),
        })
    }

    /// In-memory store for tests.
    pub fn open_in_memory(key: EncryptionKey) -> Result<Self, StoreError> {
        let mut connection = Connection::open_in_memory()?;
        connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        migrate_database(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            key,
            session_revision: AtomicU64::new(0),
        })
    }

    fn with_connection<T>(&self, f: impl FnOnce(&Connection) -> Result<T, StoreError>) -> Result<T, StoreError> {
        let guard = self.connection.lock().expect("store connection mutex");
        f(&guard)
    }

    /// Mirrors `databaseHealthy`.
    pub fn database_healthy(&self) -> bool {
        self.with_connection(|db| {
            let ok: i64 = db.query_row("SELECT 1 AS ok", [], |row| row.get(0))?;
            Ok(ok == 1)
        })
        .unwrap_or(false)
    }

    // ---- settings KV -----------------------------------------------------

    fn read_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.with_connection(|db| {
            Ok(db
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [key],
                    |row| row.get::<_, String>(0),
                )
                .optional()?)
        })
    }

    fn write_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let updated_at = now_iso8601();
        self.with_connection(|db| {
            db.execute(
                "INSERT INTO settings(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                rusqlite::params![key, value, updated_at],
            )?;
            Ok(())
        })
    }

    // ---- session revision ------------------------------------------------

    /// Mirrors `getSessionRevision`.
    pub fn session_revision(&self) -> u64 {
        self.session_revision.load(Ordering::SeqCst)
    }

    fn changed_session(&self) {
        self.session_revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Mirrors `assertSessionRevision` — the optimistic-concurrency guard that
    /// prevents a token minted for one account being persisted after the
    /// session was swapped to another.
    pub fn assert_session_revision(&self, expected: u64) -> Result<(), StoreError> {
        if expected == self.session_revision() {
            Ok(())
        } else {
            Err(StoreError::SessionChanged)
        }
    }

    // ---- session ---------------------------------------------------------

    /// Mirrors `getSession`. Returns `None` when no session is stored.
    pub fn session(&self) -> Result<Option<StoredSession>, StoreError> {
        let Some(sealed) = self.read_setting(SESSION_KEY)? else {
            return Ok(None);
        };
        let plaintext = self.key.decrypt(&sealed)?;
        serde_json::from_str(&plaintext)
            .map(Some)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))
    }

    /// Persists `session`, encrypted, and bumps the session revision.
    pub fn save_session(&self, session: &StoredSession) -> Result<(), StoreError> {
        let json = serde_json::to_string(session)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(SESSION_KEY, &self.key.encrypt(&json))?;
        self.changed_session();
        Ok(())
    }

    /// Mirrors `clearSession`: removes the row and bumps the revision so any
    /// in-flight mint for the old session is rejected.
    pub fn clear_session(&self) -> Result<(), StoreError> {
        self.changed_session();
        self.with_connection(|db| {
            db.execute("DELETE FROM settings WHERE key = 'session'", [])?;
            Ok(())
        })
    }

    /// Mirrors `updateMintedToken`: caches a freshly minted access token and
    /// persists a rotated session token when NextAuth supplied one. A missing
    /// session is a no-op, as upstream.
    pub fn update_minted_token(
        &self,
        access_token: &str,
        expires_at: i64,
        rotated_session_token: Option<&str>,
    ) -> Result<(), StoreError> {
        let Some(mut session) = self.session()? else {
            return Ok(());
        };
        session.cached_access_token = Some(access_token.to_string());
        session.cached_access_token_expires_at = Some(expires_at);
        if let Some(rotated) = rotated_session_token {
            session.session_token = rotated.to_string();
        }
        // Upstream's updateMintedToken writes the setting directly without
        // going through changedSession(), so refreshing a token does not
        // invalidate concurrent work for the same session.
        let json = serde_json::to_string(&session)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(SESSION_KEY, &self.key.encrypt(&json))
    }

    // ---- account-wide settings -------------------------------------------

    /// Mirrors `getDefaultSystemInstructions` — "" when unset.
    pub fn default_system_instructions(&self, account_id: &str) -> Result<String, StoreError> {
        Ok(self
            .read_setting(&format!("{DEFAULT_SYSTEM_INSTRUCTIONS_KEY_PREFIX}{account_id}"))?
            .unwrap_or_default())
    }

    pub fn set_default_system_instructions(
        &self,
        account_id: &str,
        content: &str,
    ) -> Result<(), StoreError> {
        self.write_setting(
            &format!("{DEFAULT_SYSTEM_INSTRUCTIONS_KEY_PREFIX}{account_id}"),
            content,
        )
    }

    /// Mirrors `getHotkeys`: per-account overrides only, with non-string
    /// values dropped and any malformed payload degrading to an empty map
    /// rather than erroring (the client falls back to its built-in defaults).
    pub fn hotkeys(&self, account_id: &str) -> Result<Vec<(String, String)>, StoreError> {
        let Some(raw) = self.read_setting(&format!("{HOTKEYS_KEY_PREFIX}{account_id}"))? else {
            return Ok(Vec::new());
        };
        let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(&raw)
        else {
            return Ok(Vec::new());
        };
        Ok(map
            .into_iter()
            .filter_map(|(k, v)| match v {
                serde_json::Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect())
    }

    pub fn set_hotkeys(&self, account_id: &str, hotkeys: &[(String, String)]) -> Result<(), StoreError> {
        let map: serde_json::Map<String, serde_json::Value> = hotkeys
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let json = serde_json::to_string(&map)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(&format!("{HOTKEYS_KEY_PREFIX}{account_id}"), &json)
    }
}

fn now_iso8601() -> String {
    // Matches `new Date().toISOString()`.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let millis = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time_of_day / 3600,
        (time_of_day % 3600) / 60,
        time_of_day % 60,
    )
}

/// Howard Hinnant's `civil_from_days`, avoiding a date dependency here.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> Store {
        Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap()).unwrap()
    }

    fn session() -> StoredSession {
        StoredSession {
            session_token: "session-token-value".to_string(),
            device_id: "device-1".to_string(),
            saved_at: "2026-09-17T00:00:00.000Z".to_string(),
            account_id: Some("acct-1".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn a_fresh_store_is_healthy_and_has_no_session() {
        let s = store();
        assert!(s.database_healthy());
        assert_eq!(s.session().unwrap(), None);
    }

    #[test]
    fn session_round_trips_through_encryption() {
        let s = store();
        s.save_session(&session()).unwrap();
        assert_eq!(s.session().unwrap(), Some(session()));
    }

    #[test]
    fn the_stored_session_row_is_encrypted_not_plaintext() {
        let s = store();
        s.save_session(&session()).unwrap();
        let raw = s.read_setting(SESSION_KEY).unwrap().unwrap();
        assert!(raw.starts_with("v1."), "expected the v1 envelope, got {raw}");
        assert!(
            !raw.contains("session-token-value"),
            "the session token must not be recoverable from the row"
        );
    }

    #[test]
    fn saving_a_session_bumps_the_revision_and_clearing_bumps_it_again() {
        let s = store();
        assert_eq!(s.session_revision(), 0);
        s.save_session(&session()).unwrap();
        assert_eq!(s.session_revision(), 1);
        s.clear_session().unwrap();
        assert_eq!(s.session_revision(), 2);
        assert_eq!(s.session().unwrap(), None);
    }

    #[test]
    fn assert_session_revision_guards_against_a_concurrent_session_swap() {
        let s = store();
        let observed = s.session_revision();
        assert!(s.assert_session_revision(observed).is_ok());
        s.save_session(&session()).unwrap();
        // A mint that started before the swap must be rejected.
        assert!(matches!(
            s.assert_session_revision(observed),
            Err(StoreError::SessionChanged)
        ));
    }

    #[test]
    fn update_minted_token_caches_the_token_without_bumping_the_revision() {
        let s = store();
        s.save_session(&session()).unwrap();
        let revision = s.session_revision();

        s.update_minted_token("access-abc", 1_800_000_000_000, None).unwrap();

        let stored = s.session().unwrap().unwrap();
        assert_eq!(stored.cached_access_token.as_deref(), Some("access-abc"));
        assert_eq!(stored.cached_access_token_expires_at, Some(1_800_000_000_000));
        // Unchanged: refreshing a token must not invalidate concurrent work.
        assert_eq!(s.session_revision(), revision);
        // The session token itself is untouched when nothing rotated.
        assert_eq!(stored.session_token, "session-token-value");
    }

    #[test]
    fn update_minted_token_persists_a_rotated_session_token() {
        let s = store();
        s.save_session(&session()).unwrap();
        s.update_minted_token("access-abc", 1, Some("rotated-token"))
            .unwrap();
        assert_eq!(
            s.session().unwrap().unwrap().session_token,
            "rotated-token",
            "a rotated session token must be persisted or the next mint fails"
        );
    }

    #[test]
    fn update_minted_token_is_a_no_op_without_a_session() {
        let s = store();
        assert!(s.update_minted_token("access", 1, None).is_ok());
        assert_eq!(s.session().unwrap(), None);
    }

    #[test]
    fn optional_session_fields_are_omitted_from_the_encrypted_json() {
        // Matches JSON.stringify dropping undefined properties, so a session
        // written by either implementation decodes in the other.
        let s = store();
        s.save_session(&session()).unwrap();
        let raw = s.read_setting(SESSION_KEY).unwrap().unwrap();
        let json = s.key.decrypt(&raw).unwrap();
        assert!(!json.contains("turnstileToken"));
        assert!(!json.contains("cachedAccessToken"));
        assert!(json.contains("\"accountId\":\"acct-1\""));
    }

    #[test]
    fn default_system_instructions_are_per_account_and_default_to_empty() {
        let s = store();
        assert_eq!(s.default_system_instructions("acct-1").unwrap(), "");
        s.set_default_system_instructions("acct-1", "be terse").unwrap();
        assert_eq!(s.default_system_instructions("acct-1").unwrap(), "be terse");
        // A different account is unaffected.
        assert_eq!(s.default_system_instructions("acct-2").unwrap(), "");
    }

    #[test]
    fn settings_writes_upsert_rather_than_duplicating() {
        let s = store();
        s.set_default_system_instructions("acct-1", "first").unwrap();
        s.set_default_system_instructions("acct-1", "second").unwrap();
        assert_eq!(s.default_system_instructions("acct-1").unwrap(), "second");
        let count: i64 = s
            .with_connection(|db| Ok(db.query_row("SELECT count(*) FROM settings", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn hotkeys_round_trip_and_drop_non_string_values() {
        let s = store();
        assert!(s.hotkeys("acct-1").unwrap().is_empty());

        s.set_hotkeys(
            "acct-1",
            &[("send".to_string(), "mod+enter".to_string())],
        )
        .unwrap();
        assert_eq!(
            s.hotkeys("acct-1").unwrap(),
            vec![("send".to_string(), "mod+enter".to_string())]
        );

        // A payload with a non-string value keeps only the string entries.
        s.write_setting("hotkeys:acct-2", r#"{"a":"x","b":3,"c":null}"#)
            .unwrap();
        assert_eq!(
            s.hotkeys("acct-2").unwrap(),
            vec![("a".to_string(), "x".to_string())]
        );
    }

    #[test]
    fn malformed_hotkeys_degrade_to_empty_instead_of_erroring() {
        let s = store();
        for raw in ["not json", "[1,2]", "\"a string\"", "null"] {
            s.write_setting("hotkeys:acct-1", raw).unwrap();
            assert!(
                s.hotkeys("acct-1").unwrap().is_empty(),
                "{raw} should degrade to an empty map"
            );
        }
    }

    #[test]
    fn a_session_encrypted_with_a_different_key_fails_to_decrypt() {
        // Guards the MIRROR_STORE_KEY-rotation failure mode: a wrong key must
        // surface as an error rather than silently yielding no session.
        let s = store();
        s.save_session(&session()).unwrap();
        let raw = s.read_setting(SESSION_KEY).unwrap().unwrap();

        let other = Store::open_in_memory(
            EncryptionKey::decode_configured(&"cd".repeat(32)).unwrap(),
        )
        .unwrap();
        other.write_setting(SESSION_KEY, &raw).unwrap();
        assert!(matches!(other.session(), Err(StoreError::Crypto(_))));
    }

    #[test]
    fn streaming_messages_are_marked_interrupted_on_open() {
        // A process that died mid-stream leaves `streaming` rows behind with
        // no writer; reopening must not present them as still live.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mirror.db");
        let key = || EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap();

        {
            let s = Store::open(&path, key()).unwrap();
            s.with_connection(|db| {
                db.execute(
                    "INSERT INTO conversations (id, current_node_id, model, title, created_at, updated_at) VALUES ('c1','n1','gpt','t','now','now')",
                    [],
                )?;
                db.execute(
                    "INSERT INTO messages (id, conversation_id, role, content, status, created_at) VALUES ('m1','c1','assistant','partial','streaming','now')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }

        let reopened = Store::open(&path, key()).unwrap();
        let status: String = reopened
            .with_connection(|db| {
                Ok(db.query_row("SELECT status FROM messages WHERE id = 'm1'", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(status, "interrupted");
    }

    #[test]
    fn reads_a_session_written_by_the_original_node_implementation() {
        // Encrypted with Node's node:crypto using the same key this test's
        // store uses (32 bytes of 0xab), holding exactly the JSON shape
        // store.ts writes -- proving an existing on-disk database opens
        // unchanged under the rewrite.
        const NODE_SESSION: &str = "v1.BQUFBQUFBQUFBQUF.o1rUgAS3lYu-btrLLhCpgQ.yCjfTUN6mQpmn0C7Bcp7zOZZ1WhsJB_-PhNXeLrg3L70ydHy3R_z2XZtfNi-97wtNHfdOBPY7PM9KD93uAozk1TsNkFgBn7359arx9HzdXbUMArdRlXi-rtwybRc1cNXNYs1WlZbn5YET0xmctKVgxGIyHRqwBEXvwOeaIFWh1hCAfxnJroTROC639r72KGNI8jMENsOQTjKY8m-QMa-8_mfMAvmUzBDBPuSz7GmQ1duOwJO8OrARl3N5DgkjTQdkcs";

        let s = store();
        s.write_setting(SESSION_KEY, NODE_SESSION).unwrap();

        let decoded = s.session().unwrap().expect("should decode");
        assert_eq!(decoded.session_token, "session-token-value");
        assert_eq!(decoded.device_id, "device-1");
        assert_eq!(decoded.saved_at, "2026-09-17T00:00:00.000Z");
        assert_eq!(decoded.account_id.as_deref(), Some("acct-1"));
        assert_eq!(decoded.cached_access_token.as_deref(), Some("cached-jwt"));
        assert_eq!(
            decoded.cached_access_token_expires_at,
            Some(1_800_000_000_000)
        );
        // Absent in the Node payload (JSON.stringify dropped it).
        assert_eq!(decoded.turnstile_token, None);
    }

    #[test]
    fn iso_timestamps_match_the_javascript_shape() {
        let stamp = now_iso8601();
        assert_eq!(stamp.len(), 24, "{stamp} should be millisecond precision");
        assert!(stamp.ends_with('Z'));
        assert_eq!(stamp.as_bytes()[4], b'-');
        assert_eq!(stamp.as_bytes()[10], b'T');
    }
}
