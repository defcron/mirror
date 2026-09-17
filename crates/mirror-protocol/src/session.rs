//! Turns a long-lived NextAuth session token into short-lived backend-api
//! access tokens — port of `packages/protocol/src/session.ts`.
//!
//! chatgpt.com's `accessToken` (the `Authorization: Bearer` value for
//! backend-api) is short-lived. The `__Secure-next-auth.session-token` cookie
//! that mints it lives longer, and `GET /api/auth/session` with that cookie
//! returns a fresh access token. Critically, NextAuth **rotates** the session
//! token on each such call: the response's `Set-Cookie` may carry a new
//! value that must be persisted, or the next mint will use a stale one.
//!
//! One deliberate improvement over the TS version: it hardcoded its own
//! Chrome 128 User-Agent here while `proxy.ts` separately hardcoded Chrome
//! 152, so Mirror presented two different browser identities depending on
//! which code path made the call. Both now come from [`crate::http`], which
//! also keeps them consistent with the emulated TLS fingerprint.

use crate::http;
use serde_json::Value;

const SESSION_URL: &str = "https://chatgpt.com/api/auth/session";
const SESSION_COOKIE_NAME: &str = "__Secure-next-auth.session-token";
/// Fallback lifetime when the JWT's `exp` claim cannot be read.
const FALLBACK_LIFETIME_MS: i64 = 10 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MintedAccessToken {
    pub access_token: String,
    /// Epoch ms after which the token should be treated as expired.
    pub expires_at: i64,
    /// Set when the server rotated the session token on this call. Callers
    /// MUST persist it, or later mints fail once the old value stops being
    /// honored.
    pub rotated_session_token: Option<String>,
}

/// Mirrors `SessionTokenInvalidError` — the session token itself is no good,
/// as distinct from a transport failure.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(
        "Session token was rejected or has no accessToken in the response — it's likely expired."
    )]
    SessionTokenInvalid,
    #[error("GET /api/auth/session returned {0}")]
    UnexpectedStatus(u16),
    #[error("session request failed: {0}")]
    Transport(String),
}

/// Decode a JWT's `exp` claim (seconds since epoch) without verifying the
/// signature. Mirrors `decodeJwtExpSeconds`: we hold no key, and the value
/// is only used to decide when to re-mint. Returns `None` on any problem, in
/// which case the caller falls back to a short lifetime.
pub fn decode_jwt_exp_seconds(jwt: &str) -> Option<i64> {
    let payload_b64url = jwt.split('.').nth(1)?;
    // Manual base64url -> base64 + padding, matching the TS implementation
    // rather than assuming a URL-safe decoder.
    let b64 = payload_b64url.replace('-', "+").replace('_', "/");
    let padded = {
        let pad = (4 - (b64.len() % 4)) % 4;
        format!("{b64}{}", "=".repeat(pad))
    };
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(padded)
        .ok()?;
    let claims: Value = serde_json::from_slice(&decoded).ok()?;
    // `typeof claims.exp === "number"`: a string exp is ignored, not parsed.
    claims.get("exp")?.as_f64().map(|exp| exp as i64)
}

/// Mirrors `extractRotatedSessionToken`: scans every `Set-Cookie` value for
/// a new session-token cookie.
fn extract_rotated_session_token<'a, I>(set_cookies: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let needle = format!("{SESSION_COOKIE_NAME}=");
    for cookie in set_cookies {
        if let Some(start) = cookie.find(&needle) {
            let value = &cookie[start + needle.len()..];
            let value = value.split(';').next().unwrap_or("");
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Exchange a session token for a fresh access token. Mirrors
/// `mintAccessToken`.
pub async fn mint_access_token(
    client: &wreq::Client,
    session_token: &str,
    now_millis: i64,
) -> Result<MintedAccessToken, SessionError> {
    let response = client
        .get(SESSION_URL)
        .header("cookie", format!("{SESSION_COOKIE_NAME}={session_token}"))
        .header("accept", "application/json")
        .header("user-agent", http::user_agent())
        .send()
        .await
        .map_err(|e| SessionError::Transport(e.to_string()))?;

    let status = response.status();
    let set_cookies: Vec<String> = response
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_string))
        .collect();

    if !status.is_success() {
        return Err(SessionError::UnexpectedStatus(status.as_u16()));
    }

    let body = response
        .text()
        .await
        .map_err(|e| SessionError::Transport(e.to_string()))?;

    // A body that will not parse is treated the same as a missing token,
    // matching `.catch(() => null)` upstream.
    let access_token = serde_json::from_str::<Value>(&body)
        .ok()
        .as_ref()
        .and_then(|json| json.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .ok_or(SessionError::SessionTokenInvalid)?;

    let expires_at = decode_jwt_exp_seconds(&access_token)
        .map(|exp| exp * 1000)
        .unwrap_or(now_millis + FALLBACK_LIFETIME_MS);

    Ok(MintedAccessToken {
        access_token,
        expires_at,
        rotated_session_token: extract_rotated_session_token(
            set_cookies.iter().map(String::as_str),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn jwt_with_claims(claims: &str) -> String {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims);
        format!("header.{payload}.signature")
    }

    #[test]
    fn jwt_exp_is_decoded_from_an_unpadded_base64url_payload() {
        let jwt = jwt_with_claims(r#"{"exp":1800000000,"sub":"user"}"#);
        assert_eq!(decode_jwt_exp_seconds(&jwt), Some(1_800_000_000));
    }

    #[test]
    fn jwt_exp_decoding_handles_every_padding_length() {
        // The manual re-padding must cope with payload lengths ≡ 0,2,3 mod 4.
        for filler in ["a", "ab", "abc", "abcd"] {
            let jwt = jwt_with_claims(&format!(r#"{{"exp":1700000000,"pad":"{filler}"}}"#));
            assert_eq!(
                decode_jwt_exp_seconds(&jwt),
                Some(1_700_000_000),
                "failed for filler {filler}"
            );
        }
    }

    #[test]
    fn jwt_exp_is_none_for_malformed_or_non_numeric_claims() {
        // `typeof claims.exp === "number"` upstream, so a string is ignored
        // rather than parsed.
        assert_eq!(decode_jwt_exp_seconds(&jwt_with_claims(r#"{"exp":"1800"}"#)), None);
        assert_eq!(decode_jwt_exp_seconds(&jwt_with_claims(r#"{"sub":"x"}"#)), None);
        assert_eq!(decode_jwt_exp_seconds(&jwt_with_claims("not json")), None);
        // No payload segment at all.
        assert_eq!(decode_jwt_exp_seconds("single-segment"), None);
        assert_eq!(decode_jwt_exp_seconds(""), None);
        // Payload that is not valid base64.
        assert_eq!(decode_jwt_exp_seconds("header.!!!.sig"), None);
    }

    #[test]
    fn a_rotated_session_token_is_extracted_from_any_set_cookie_value() {
        let cookies = [
            "other=1; Path=/",
            "__Secure-next-auth.session-token=rotated-value; Path=/; HttpOnly; Secure",
            "trailing=2",
        ];
        assert_eq!(
            extract_rotated_session_token(cookies),
            Some("rotated-value".to_string())
        );
    }

    #[test]
    fn rotation_extraction_takes_the_first_match_and_stops_at_the_semicolon() {
        let cookies = [
            "__Secure-next-auth.session-token=first; Path=/",
            "__Secure-next-auth.session-token=second; Path=/",
        ];
        assert_eq!(
            extract_rotated_session_token(cookies),
            Some("first".to_string())
        );
    }

    #[test]
    fn no_rotation_yields_none() {
        assert_eq!(extract_rotated_session_token(["unrelated=1; Path=/"]), None);
        assert_eq!(extract_rotated_session_token([]), None);
        // A present-but-empty value is not a rotation.
        assert_eq!(
            extract_rotated_session_token(["__Secure-next-auth.session-token=; Path=/"]),
            None
        );
    }

    #[test]
    fn the_session_url_and_cookie_name_match_upstream_exactly() {
        // These two strings are the whole contract with NextAuth; a typo
        // would fail only at runtime against the live service.
        assert_eq!(SESSION_URL, "https://chatgpt.com/api/auth/session");
        assert_eq!(SESSION_COOKIE_NAME, "__Secure-next-auth.session-token");
    }

    #[test]
    fn the_invalid_session_message_matches_upstream() {
        // apps/server pattern-matches on this text when classifying errors.
        assert_eq!(
            SessionError::SessionTokenInvalid.to_string(),
            "Session token was rejected or has no accessToken in the response — it's likely expired."
        );
        assert_eq!(
            SessionError::UnexpectedStatus(403).to_string(),
            "GET /api/auth/session returned 403"
        );
    }
}
