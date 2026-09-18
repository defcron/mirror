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
    Io(#[from] std::io::Error),
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
    #[serde(
        rename = "assetLinkGeneration",
        skip_serializing_if = "Option::is_none"
    )]
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

const ASSET_TICKET_PURPOSE: &str = "mirror-asset-v1";

/// Mirrors `AssetTicket` — the caller-visible half of a sealed ticket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetTicket {
    pub pointer: String,
    pub conversation_id: Option<String>,
    pub message_id: Option<String>,
    pub file_name: String,
}

/// The full sealed payload. Field order matches the object literal upstream
/// builds, so a ticket minted by either implementation is byte-identical.
#[derive(Debug, Serialize, Deserialize)]
struct SealedAssetTicket {
    purpose: String,
    pointer: String,
    #[serde(rename = "conversationId")]
    conversation_id: Option<String>,
    #[serde(rename = "messageId")]
    message_id: Option<String>,
    #[serde(rename = "fileName")]
    file_name: String,
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "sessionGeneration")]
    session_generation: String,
    #[serde(rename = "expiresAt")]
    expires_at: i64,
}

/// Mirrors `/^(?:file-service:\/\/|sediment:\/\/|sandbox:\/)/` — the only
/// pointer schemes a ticket may name.
fn is_allowed_asset_pointer(pointer: &str) -> bool {
    pointer.starts_with("file-service://")
        || pointer.starts_with("sediment://")
        || pointer.starts_with("sandbox:/")
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
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

    pub(crate) fn with_conn<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let guard = self.connection.lock().expect("store connection mutex");
        f(&guard)
    }

    /// Mirrors `databaseHealthy`.
    pub fn database_healthy(&self) -> bool {
        self.with_conn(|db| {
            let ok: i64 = db.query_row("SELECT 1 AS ok", [], |row| row.get(0))?;
            Ok(ok == 1)
        })
        .unwrap_or(false)
    }

    // ---- settings KV -----------------------------------------------------

    pub(crate) fn read_setting_pub(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.read_setting(key)
    }

    pub(crate) fn write_setting_pub(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.write_setting(key, value)
    }

    fn read_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.with_conn(|db| {
            Ok(db
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?)
        })
    }

    fn write_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let updated_at = now_iso8601();
        self.with_conn(|db| {
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
        self.with_conn(|db| {
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

    /// Mirrors `saveVerifiedSession`. Bumps the revision first, then
    /// preserves the prior device id and pending Turnstile token only when
    /// this is recognizably the *same* session, and always mints a fresh
    /// `assetLinkGeneration` so previously issued asset tickets stop opening.
    pub fn save_verified_session(
        &self,
        session_token: &str,
        account_id: Option<&str>,
        device_id: Option<&str>,
        turnstile_token: Option<&str>,
    ) -> Result<StoredSession, StoreError> {
        self.changed_session();
        let prior = self.session()?;

        let is_same_session = prior.as_ref().is_some_and(|p| {
            p.session_token == session_token
                && match (account_id, p.account_id.as_deref()) {
                    (Some(incoming), Some(existing)) => incoming == existing,
                    // An absent id on either side is not a mismatch.
                    _ => true,
                }
        });

        let effective_turnstile = turnstile_token.map(str::to_string).or_else(|| {
            is_same_session
                .then(|| prior.as_ref().and_then(|p| p.turnstile_token.clone()))
                .flatten()
        });
        let effective_turnstile_saved_at = if turnstile_token.is_some() {
            Some(now_epoch_millis())
        } else {
            is_same_session
                .then(|| prior.as_ref().and_then(|p| p.turnstile_token_saved_at))
                .flatten()
        };

        let session = StoredSession {
            session_token: session_token.to_string(),
            device_id: device_id
                .map(str::to_string)
                .or_else(|| {
                    is_same_session
                        .then(|| prior.as_ref().map(|p| p.device_id.clone()))
                        .flatten()
                })
                .unwrap_or_else(new_uuid),
            saved_at: now_iso8601(),
            asset_link_generation: Some(new_uuid()),
            account_id: account_id.filter(|v| !v.is_empty()).map(str::to_string),
            cached_access_token: None,
            cached_access_token_expires_at: None,
            // Upstream spreads these in only when truthy, so an empty string
            // or a zero timestamp is omitted rather than stored.
            turnstile_token: effective_turnstile.filter(|v| !v.is_empty()),
            turnstile_token_saved_at: effective_turnstile_saved_at.filter(|v| *v != 0),
        };

        let json = serde_json::to_string(&session)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(SESSION_KEY, &self.key.encrypt(&json))?;
        Ok(session)
    }

    /// Mirrors `setSessionTurnstileToken`: stores or clears the pending
    /// challenge token. A missing session is a no-op.
    pub fn set_session_turnstile_token(&self, token: Option<&str>) -> Result<(), StoreError> {
        let Some(mut session) = self.session()? else {
            return Ok(());
        };
        match token {
            Some(token) if !token.is_empty() => {
                session.turnstile_token = Some(token.to_string());
                session.turnstile_token_saved_at = Some(now_epoch_millis());
            }
            _ => {
                session.turnstile_token = None;
                session.turnstile_token_saved_at = None;
            }
        }
        self.persist_session_without_revision_bump(&session)
    }

    /// Mirrors `consumeSessionTurnstileToken`: removes the token whether or
    /// not it is still fresh (it is strictly single-use), but only *returns*
    /// it when saved within the last five minutes.
    pub fn consume_session_turnstile_token(&self) -> Result<Option<String>, StoreError> {
        let Some(mut session) = self.session()? else {
            return Ok(None);
        };
        let Some(token) = session.turnstile_token.take() else {
            return Ok(None);
        };
        let saved_at = session.turnstile_token_saved_at.take();
        self.persist_session_without_revision_bump(&session)?;

        Ok(match saved_at {
            Some(saved_at) if now_epoch_millis() - saved_at <= 5 * 60_000 => Some(token),
            _ => None,
        })
    }

    /// Mirrors `setSessionAccountId`: a no-op when unchanged, and otherwise
    /// also claims any pre-account-key local data for the account.
    pub fn set_session_account_id(&self, account_id: &str) -> Result<(), StoreError> {
        let Some(mut session) = self.session()? else {
            return Ok(());
        };
        if session.account_id.as_deref() == Some(account_id) {
            return Ok(());
        }
        session.account_id = Some(account_id.to_string());
        self.persist_session_without_revision_bump(&session)?;
        self.claim_default_account_data(account_id)
    }

    fn persist_session_without_revision_bump(
        &self,
        session: &StoredSession,
    ) -> Result<(), StoreError> {
        let json = serde_json::to_string(session)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(SESSION_KEY, &self.key.encrypt(&json))
    }

    /// Mirrors `claimDefaultAccountData`: attaches data written by earlier
    /// builds (before account keying) to the verified account.
    pub fn claim_default_account_data(&self, account_id: &str) -> Result<(), StoreError> {
        self.with_conn(|db| {
            db.execute(
                "UPDATE conversations SET account_id = ?1 WHERE account_id = 'default'",
                [account_id],
            )?;
            db.execute(
                "UPDATE files SET account_id = ?1 WHERE account_id = 'default'",
                [account_id],
            )?;
            Ok(())
        })
    }

    // ---- sealed asset tickets --------------------------------------------

    /// Mirrors `sealAssetTicket`. The ticket is a sealed, file-scoped
    /// capability: it carries no API key and no upstream URL, and is bound to
    /// both the account and the session's asset-link generation so it stops
    /// opening once the session is replaced.
    pub fn seal_asset_ticket(
        &self,
        asset: &AssetTicket,
        now_millis: i64,
    ) -> Result<String, StoreError> {
        let session = self
            .session()?
            .ok_or_else(|| StoreError::MalformedSession("No session configured".to_string()))?;
        let sealed = SealedAssetTicket {
            purpose: ASSET_TICKET_PURPOSE.to_string(),
            pointer: asset.pointer.clone(),
            conversation_id: asset.conversation_id.clone(),
            message_id: asset.message_id.clone(),
            file_name: asset.file_name.clone(),
            account_id: session
                .account_id
                .clone()
                .unwrap_or_else(|| "default".to_string()),
            session_generation: session
                .asset_link_generation
                .clone()
                .unwrap_or_else(|| session.saved_at.clone()),
            expires_at: now_millis + 7 * 24 * 60 * 60 * 1000,
        };
        let json = serde_json::to_string(&sealed)
            .map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        Ok(self.key.encrypt(&json))
    }

    /// Mirrors `openAssetTicket`. Every validation failure yields `None`
    /// rather than an error, exactly as upstream's catch-all does, so a
    /// malformed or stale ticket is simply unusable.
    pub fn open_asset_ticket(&self, ticket: &str, now_millis: i64) -> Option<AssetTicket> {
        // Bound the work before attempting to decrypt an attacker-supplied
        // value at all.
        if ticket.len() > 12000 {
            return None;
        }
        let plaintext = self.key.decrypt(ticket).ok()?;
        let sealed: SealedAssetTicket = serde_json::from_str(&plaintext).ok()?;
        let session = self.session().ok()??;

        let expected_account = session
            .account_id
            .clone()
            .unwrap_or_else(|| "default".to_string());
        let expected_generation = session
            .asset_link_generation
            .clone()
            .unwrap_or_else(|| session.saved_at.clone());

        if sealed.purpose != ASSET_TICKET_PURPOSE
            || sealed.account_id != expected_account
            || sealed.session_generation != expected_generation
            || sealed.expires_at <= now_millis
            || !is_allowed_asset_pointer(&sealed.pointer)
        {
            return None;
        }

        Some(AssetTicket {
            pointer: sealed.pointer,
            conversation_id: sealed.conversation_id,
            message_id: sealed.message_id,
            file_name: sealed.file_name,
        })
    }

    // ---- account-wide settings -------------------------------------------

    /// Mirrors `getDefaultSystemInstructions` — "" when unset.
    pub fn default_system_instructions(&self, account_id: &str) -> Result<String, StoreError> {
        Ok(self
            .read_setting(&format!(
                "{DEFAULT_SYSTEM_INSTRUCTIONS_KEY_PREFIX}{account_id}"
            ))?
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

    pub fn set_hotkeys(
        &self,
        account_id: &str,
        hotkeys: &[(String, String)],
    ) -> Result<(), StoreError> {
        let map: serde_json::Map<String, serde_json::Value> = hotkeys
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect();
        let json =
            serde_json::to_string(&map).map_err(|e| StoreError::MalformedSession(e.to_string()))?;
        self.write_setting(&format!("{HOTKEYS_KEY_PREFIX}{account_id}"), &json)
    }
}

pub(crate) fn now_epoch_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn now_iso8601() -> String {
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
        assert!(
            raw.starts_with("v1."),
            "expected the v1 envelope, got {raw}"
        );
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

        s.update_minted_token("access-abc", 1_800_000_000_000, None)
            .unwrap();

        let stored = s.session().unwrap().unwrap();
        assert_eq!(stored.cached_access_token.as_deref(), Some("access-abc"));
        assert_eq!(
            stored.cached_access_token_expires_at,
            Some(1_800_000_000_000)
        );
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
        s.set_default_system_instructions("acct-1", "be terse")
            .unwrap();
        assert_eq!(s.default_system_instructions("acct-1").unwrap(), "be terse");
        // A different account is unaffected.
        assert_eq!(s.default_system_instructions("acct-2").unwrap(), "");
    }

    #[test]
    fn settings_writes_upsert_rather_than_duplicating() {
        let s = store();
        s.set_default_system_instructions("acct-1", "first")
            .unwrap();
        s.set_default_system_instructions("acct-1", "second")
            .unwrap();
        assert_eq!(s.default_system_instructions("acct-1").unwrap(), "second");
        let count: i64 = s
            .with_conn(|db| Ok(db.query_row("SELECT count(*) FROM settings", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn hotkeys_round_trip_and_drop_non_string_values() {
        let s = store();
        assert!(s.hotkeys("acct-1").unwrap().is_empty());

        s.set_hotkeys("acct-1", &[("send".to_string(), "mod+enter".to_string())])
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

        let other =
            Store::open_in_memory(EncryptionKey::decode_configured(&"cd".repeat(32)).unwrap())
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
            s.with_conn(|db| {
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
            .with_conn(|db| {
                Ok(
                    db.query_row("SELECT status FROM messages WHERE id = 'm1'", [], |r| {
                        r.get(0)
                    })?,
                )
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

    fn asset() -> AssetTicket {
        AssetTicket {
            pointer: "file-service://file-abc".to_string(),
            conversation_id: Some("c1".to_string()),
            message_id: Some("m1".to_string()),
            file_name: "chart.png".to_string(),
        }
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn save_verified_session_mints_a_device_id_and_asset_generation() {
        let s = store();
        let saved = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        assert_eq!(saved.session_token, "tok-1");
        assert_eq!(saved.account_id.as_deref(), Some("acct-1"));
        assert!(!saved.device_id.is_empty());
        assert!(saved.asset_link_generation.is_some());
        assert_eq!(s.session().unwrap(), Some(saved));
    }

    #[test]
    fn save_verified_session_preserves_the_device_id_for_the_same_session() {
        let s = store();
        let first = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let second = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        assert_eq!(first.device_id, second.device_id);
        // But the asset-link generation always rotates, invalidating old
        // tickets even across an otherwise identical re-save.
        assert_ne!(first.asset_link_generation, second.asset_link_generation);
    }

    #[test]
    fn save_verified_session_mints_a_new_device_id_for_a_different_session() {
        let s = store();
        let first = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let second = s
            .save_verified_session("tok-2", Some("acct-1"), None, None)
            .unwrap();
        assert_ne!(first.device_id, second.device_id);
    }

    #[test]
    fn save_verified_session_treats_a_differing_account_as_a_new_session() {
        let s = store();
        let first = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let second = s
            .save_verified_session("tok-1", Some("acct-2"), None, None)
            .unwrap();
        assert_ne!(first.device_id, second.device_id);
    }

    #[test]
    fn save_verified_session_carries_a_pending_turnstile_token_across_a_resave() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, Some("ts-token"))
            .unwrap();
        let resaved = s
            .save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        assert_eq!(resaved.turnstile_token.as_deref(), Some("ts-token"));
        // ...but not to a different session.
        let other = s
            .save_verified_session("tok-2", Some("acct-1"), None, None)
            .unwrap();
        assert_eq!(other.turnstile_token, None);
    }

    #[test]
    fn save_verified_session_bumps_the_revision() {
        let s = store();
        let before = s.session_revision();
        s.save_verified_session("tok-1", None, None, None).unwrap();
        assert_eq!(s.session_revision(), before + 1);
    }

    #[test]
    fn turnstile_token_can_be_set_and_cleared() {
        let s = store();
        s.save_verified_session("tok-1", None, None, None).unwrap();

        s.set_session_turnstile_token(Some("ts-1")).unwrap();
        assert_eq!(
            s.session().unwrap().unwrap().turnstile_token.as_deref(),
            Some("ts-1")
        );

        s.set_session_turnstile_token(None).unwrap();
        let session = s.session().unwrap().unwrap();
        assert_eq!(session.turnstile_token, None);
        assert_eq!(session.turnstile_token_saved_at, None);
    }

    #[test]
    fn consuming_a_turnstile_token_is_single_use() {
        let s = store();
        s.save_verified_session("tok-1", None, None, None).unwrap();
        s.set_session_turnstile_token(Some("ts-1")).unwrap();

        assert_eq!(
            s.consume_session_turnstile_token().unwrap().as_deref(),
            Some("ts-1")
        );
        // Gone from storage, so a second consume yields nothing.
        assert_eq!(s.consume_session_turnstile_token().unwrap(), None);
        assert_eq!(s.session().unwrap().unwrap().turnstile_token, None);
    }

    #[test]
    fn consuming_a_stale_turnstile_token_clears_it_but_returns_none() {
        let s = store();
        s.save_verified_session("tok-1", None, None, None).unwrap();
        // Backdate past the five-minute freshness window.
        let mut session = s.session().unwrap().unwrap();
        session.turnstile_token = Some("ts-old".to_string());
        session.turnstile_token_saved_at = Some(now_epoch_millis() - 6 * 60_000);
        s.persist_session_without_revision_bump(&session).unwrap();

        assert_eq!(s.consume_session_turnstile_token().unwrap(), None);
        // Still removed -- it is strictly single-use regardless of freshness.
        assert_eq!(s.session().unwrap().unwrap().turnstile_token, None);
    }

    #[test]
    fn setting_the_account_id_claims_pre_account_keyed_data() {
        let s = store();
        s.save_verified_session("tok-1", None, None, None).unwrap();
        s.with_conn(|db| {
            db.execute(
                "INSERT INTO conversations (id, current_node_id, model, title, created_at, updated_at) VALUES ('c1','n1','gpt','t','now','now')",
                [],
            )?;
            db.execute(
                "INSERT INTO files (id, account_id, metadata_json, created_at) VALUES ('f1','default','{}','now')",
                [],
            )?;
            Ok(())
        })
        .unwrap();

        s.set_session_account_id("acct-9").unwrap();

        let (conversations, files): (i64, i64) = s
            .with_conn(|db| {
                Ok((
                    db.query_row(
                        "SELECT count(*) FROM conversations WHERE account_id = 'acct-9'",
                        [],
                        |r| r.get(0),
                    )?,
                    db.query_row(
                        "SELECT count(*) FROM files WHERE account_id = 'acct-9'",
                        [],
                        |r| r.get(0),
                    )?,
                ))
            })
            .unwrap();
        assert_eq!((conversations, files), (1, 1));
    }

    #[test]
    fn setting_an_unchanged_account_id_is_a_no_op() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let before = s.session().unwrap().unwrap();
        s.set_session_account_id("acct-1").unwrap();
        assert_eq!(s.session().unwrap().unwrap(), before);
    }

    #[test]
    fn an_asset_ticket_round_trips() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let ticket = s.seal_asset_ticket(&asset(), NOW).unwrap();
        assert_eq!(s.open_asset_ticket(&ticket, NOW).unwrap(), asset());
    }

    #[test]
    fn sealing_a_ticket_requires_a_session() {
        let s = store();
        assert!(s.seal_asset_ticket(&asset(), NOW).is_err());
    }

    #[test]
    fn an_asset_ticket_carries_no_credential_or_upstream_url() {
        let s = store();
        s.save_verified_session("secret-session-token", Some("acct-1"), None, None)
            .unwrap();
        let ticket = s.seal_asset_ticket(&asset(), NOW).unwrap();
        let decoded = s.key.decrypt(&ticket).unwrap();
        assert!(!decoded.contains("secret-session-token"));
        assert!(!decoded.contains("chatgpt.com"));
    }

    #[test]
    fn an_expired_asset_ticket_does_not_open() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let ticket = s.seal_asset_ticket(&asset(), NOW).unwrap();
        // Exactly at expiry is already too late (`expiresAt <= now`).
        let expiry = NOW + 7 * 24 * 60 * 60 * 1000;
        assert!(s.open_asset_ticket(&ticket, expiry).is_none());
        assert!(s.open_asset_ticket(&ticket, expiry - 1).is_some());
    }

    #[test]
    fn a_ticket_stops_opening_once_the_session_is_replaced() {
        // This is the asset-link generation binding: re-saving the session
        // rotates the generation, so links from the previous session die.
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let ticket = s.seal_asset_ticket(&asset(), NOW).unwrap();
        assert!(s.open_asset_ticket(&ticket, NOW).is_some());

        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        assert!(s.open_asset_ticket(&ticket, NOW).is_none());
    }

    #[test]
    fn a_ticket_from_a_different_account_does_not_open() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let ticket = s.seal_asset_ticket(&asset(), NOW).unwrap();

        // Move the session to another account, keeping the same generation
        // so only the account check can reject the ticket.
        let mut session = s.session().unwrap().unwrap();
        session.account_id = Some("acct-2".to_string());
        s.persist_session_without_revision_bump(&session).unwrap();
        assert!(s.open_asset_ticket(&ticket, NOW).is_none());
    }

    #[test]
    fn a_ticket_naming_a_disallowed_pointer_scheme_does_not_open() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        for pointer in [
            "https://evil.example.com/x",
            "file:///etc/passwd",
            "/etc/passwd",
            "",
        ] {
            let ticket = s
                .seal_asset_ticket(
                    &AssetTicket {
                        pointer: pointer.to_string(),
                        ..asset()
                    },
                    NOW,
                )
                .unwrap();
            assert!(
                s.open_asset_ticket(&ticket, NOW).is_none(),
                "pointer {pointer:?} must be refused"
            );
        }
        // The three permitted schemes do open.
        for pointer in ["file-service://f", "sediment://s", "sandbox:/tmp/x"] {
            let ticket = s
                .seal_asset_ticket(
                    &AssetTicket {
                        pointer: pointer.to_string(),
                        ..asset()
                    },
                    NOW,
                )
                .unwrap();
            assert!(
                s.open_asset_ticket(&ticket, NOW).is_some(),
                "pointer {pointer:?} should be allowed"
            );
        }
    }

    #[test]
    fn an_oversized_or_garbage_ticket_is_refused_without_erroring() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        assert!(s.open_asset_ticket(&"x".repeat(12_001), NOW).is_none());
        assert!(s.open_asset_ticket("not-a-ticket", NOW).is_none());
        assert!(s.open_asset_ticket("", NOW).is_none());
        // A validly-encrypted value that is not a ticket at all.
        let bogus = s.key.encrypt(r#"{"hello":"world"}"#);
        assert!(s.open_asset_ticket(&bogus, NOW).is_none());
    }

    #[test]
    fn a_ticket_with_null_conversation_and_message_ids_round_trips() {
        let s = store();
        s.save_verified_session("tok-1", Some("acct-1"), None, None)
            .unwrap();
        let bare = AssetTicket {
            pointer: "sediment://x".to_string(),
            conversation_id: None,
            message_id: None,
            file_name: "f.bin".to_string(),
        };
        let ticket = s.seal_asset_ticket(&bare, NOW).unwrap();
        assert_eq!(s.open_asset_ticket(&ticket, NOW).unwrap(), bare);
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
