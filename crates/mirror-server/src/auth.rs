//! Session credential validation, token minting, and caching.
//! Port of `apps/server/src/auth.ts`.

use mirror_protocol::http::build_client;
use mirror_protocol::session::{SessionError, mint_access_token};
use mirror_protocol::types::SessionCredentials;
use mirror_store::Store;
use uuid::Uuid;

const REFRESH_BUFFER_MS: i64 = 60_000;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("No session configured. POST /api/session first.")]
    NoSession,
    #[error("Session token invalid: {0}")]
    InvalidSession(String),
    #[error("Storage error: {0}")]
    Store(#[from] mirror_store::StoreError),
    #[error("HTTP client initialization error: {0}")]
    HttpClient(String),
}

/// Returns valid backend-api credentials, minting a fresh access token from the
/// stored session token if we don't have a cached one or it's about to expire.
/// Persists both the new accessToken and any rotated session token.
pub async fn get_valid_credentials(store: &Store) -> Result<SessionCredentials, AuthError> {
    let session = store.session()?.ok_or(AuthError::NoSession)?;

    let now_ms = chrono::Utc::now().timestamp_millis();
    let needs_mint = session.cached_access_token.is_none()
        || session
            .cached_access_token_expires_at
            .map(|exp| exp - now_ms < REFRESH_BUFFER_MS)
            .unwrap_or(true);

    if !needs_mint {
        return Ok(SessionCredentials {
            access_token: session.cached_access_token.unwrap(),
            cookie: None,
            device_id: session.device_id,
            turnstile_token: None,
            session_token: Some(session.session_token),
        });
    }

    let revision = store.session_revision();
    let client = build_client().map_err(|e| AuthError::HttpClient(e.to_string()))?;
    let minted = mint_access_token(&client, &session.session_token, now_ms)
        .await
        .map_err(|e| match e {
            SessionError::SessionTokenInvalid => {
                AuthError::InvalidSession("Session token invalid or expired".into())
            }
            other => AuthError::InvalidSession(other.to_string()),
        })?;

    store.assert_session_revision(revision)?;
    store.update_minted_token(
        &minted.access_token,
        minted.expires_at,
        minted.rotated_session_token.as_deref(),
    )?;

    Ok(SessionCredentials {
        access_token: minted.access_token,
        cookie: None,
        device_id: session.device_id,
        turnstile_token: None,
        session_token: minted.rotated_session_token.or(Some(session.session_token)),
    })
}

pub struct VerifiedCandidate {
    pub credentials: SessionCredentials,
    pub persisted_session_token: String,
    pub expires_at: i64,
    pub turnstile_token: Option<String>,
}

/// Verify a candidate session token without replacing the last known-good stored credential.
pub async fn verify_candidate_session_token(
    session_token: &str,
    turnstile_token: Option<String>,
    store: &Store,
) -> Result<VerifiedCandidate, AuthError> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let client = build_client().map_err(|e| AuthError::HttpClient(e.to_string()))?;
    let minted = mint_access_token(&client, session_token, now_ms)
        .await
        .map_err(|e| AuthError::InvalidSession(e.to_string()))?;

    let prior = store.session()?;
    let device_id = prior
        .map(|p| p.device_id)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let persisted = minted
        .rotated_session_token
        .clone()
        .unwrap_or_else(|| session_token.to_string());

    Ok(VerifiedCandidate {
        credentials: SessionCredentials {
            access_token: minted.access_token,
            cookie: None,
            device_id,
            turnstile_token: turnstile_token.clone(),
            session_token: Some(persisted.clone()),
        },
        persisted_session_token: persisted,
        expires_at: minted.expires_at,
        turnstile_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirror_store::crypto::EncryptionKey;

    fn test_store() -> Store {
        Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn get_valid_credentials_fails_with_no_session() {
        let store = test_store();
        assert!(matches!(
            get_valid_credentials(&store).await,
            Err(AuthError::NoSession)
        ));
    }

    #[tokio::test]
    async fn get_valid_credentials_returns_cached_token_when_valid() {
        let store = test_store();
        let far_future = chrono::Utc::now().timestamp_millis() + 3_600_000;
        store
            .save_verified_session("test-sess", Some("acct-1"), Some("dev-123"), None)
            .unwrap();
        store
            .update_minted_token("cached-tok", far_future, None)
            .unwrap();

        let creds = get_valid_credentials(&store).await.unwrap();
        assert_eq!(creds.access_token, "cached-tok");
        assert_eq!(creds.device_id, "dev-123");
        assert_eq!(creds.session_token.as_deref(), Some("test-sess"));
    }
}
