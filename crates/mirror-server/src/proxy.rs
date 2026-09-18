//! Proxy HTTP requests to ChatGPT upstream.
//! Port of `apps/server/src/proxy.ts`.

#![allow(clippy::collapsible_if)]

use crate::auth::get_valid_credentials;
use crate::proxy_headers::safe_request_headers;
use crate::response_transform::{
    BROWSER_TOKEN, EARLY_PATCH, cache_control, is_stripped_response_header, transform_html,
    transform_text_asset,
};
use crate::router::AppState;
use crate::security::{authorized_local_request, is_allowed_origin, is_allowed_request_host};
use crate::url_rewrite::{is_rewritable_content_type, request_origin, rewrite_chatgpt_urls};
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{HeaderName, HeaderValue};
use axum::http::{Method, Request, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::sync::Arc;

pub const UPSTREAM: &str = "https://chatgpt.com";
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

/// Mirrors `/api/auth/session` to give the browser a synthetic session
/// while using our local credentials.
pub async fn mirror_auth_session(state: &AppState) -> Response {
    mirror_auth_session_at(state, UPSTREAM).await
}

pub async fn mirror_auth_session_at(state: &AppState, upstream_base: &str) -> Response {
    let credentials = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                [(axum::http::header::CACHE_CONTROL, "no-store")],
                axum::Json(json!({
                    "error": "unauthorized",
                })),
            )
                .into_response();
        }
    };

    let me_url = format!("{upstream_base}/backend-api/me");
    let resp = state
        .http
        .get(&me_url)
        .header("accept", "application/json")
        .header(
            "authorization",
            format!("Bearer {}", credentials.access_token),
        )
        .header("oai-device-id", &credentials.device_id)
        .header("user-agent", USER_AGENT)
        .send()
        .await;

    let me_json: serde_json::Value = match resp {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(json!({})),
        _ => json!({}),
    };

    let account = me_json.get("account").cloned().unwrap_or(json!({}));
    let user_id = account
        .get("account_user_id")
        .and_then(|v| v.as_str())
        .or_else(|| me_json.get("id").and_then(|v| v.as_str()))
        .unwrap_or("mirror-user");

    let name = me_json
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| account.get("name").and_then(|v| v.as_str()))
        .unwrap_or("ChatGPT user");

    let email = me_json.get("email").and_then(|v| v.as_str());

    let expires = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();

    (
        StatusCode::OK,
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        axum::Json(json!({
            "user": {
                "id": user_id,
                "name": name,
                "email": email,
                "image": serde_json::Value::Null,
            },
            "expires": expires,
            "accessToken": BROWSER_TOKEN,
            "authProvider": "mirror-session-token",
        })),
    )
        .into_response()
}

/// Resolves the ChatGPT account ID from `/backend-api/me` if not yet stored.
pub async fn resolve_account_id(
    state: &AppState,
    access_token: &str,
    device_id: &str,
) -> Option<String> {
    resolve_account_id_at(state, UPSTREAM, access_token, device_id).await
}

pub async fn resolve_account_id_at(
    state: &AppState,
    upstream_base: &str,
    access_token: &str,
    device_id: &str,
) -> Option<String> {
    if let Ok(Some(sess)) = state.store.session() {
        if let Some(id) = sess.account_id {
            if !id.is_empty() {
                return Some(id);
            }
        }
    }

    let me_url = format!("{upstream_base}/backend-api/me");
    let resp = state
        .http
        .get(&me_url)
        .header("accept", "application/json")
        .header("authorization", format!("Bearer {access_token}"))
        .header("oai-device-id", device_id)
        .header("user-agent", USER_AGENT)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let me: serde_json::Value = resp.json().await.ok()?;
    let account = me.get("account");
    let account_id = account
        .and_then(|a| a.get("account_user_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            let orgs = me
                .get("orgs")
                .and_then(|o| o.get("data"))
                .and_then(|d| d.as_array())?;
            orgs.first()?.get("id")?.as_str().map(str::to_string)
        });

    if let Some(ref id) = account_id {
        let _ = state.store.set_session_account_id(id);
    }
    account_id
}

/// Fallback proxy handler forwarding requests to `https://chatgpt.com`.
pub async fn proxy_chatgpt(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response {
    proxy_request_to_upstream(&state, UPSTREAM, req).await
}

pub async fn proxy_request_to_upstream(
    state: &AppState,
    upstream_base: &str,
    req: Request<Body>,
) -> Response {
    let (parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    if path_and_query.starts_with("/api/auth/session") {
        return mirror_auth_session_at(state, upstream_base).await;
    }

    if path_and_query.starts_with("/v1/") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({ "error": "Not found" })),
        )
            .into_response();
    }

    // Origin and Host security check
    let host = parts.headers.get("host").and_then(|h| h.to_str().ok());
    let origin = parts.headers.get("origin").and_then(|o| o.to_str().ok());
    let auth_hdr = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok());
    let cookie_hdr = parts.headers.get("cookie").and_then(|v| v.to_str().ok());

    if !authorized_local_request(auth_hdr, cookie_hdr)
        || !is_allowed_request_host(host)
        || !is_allowed_origin(origin, host)
    {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }

    let headers_ref: Vec<(&str, &str)> = parts
        .headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.as_str(), s)))
        .collect();

    let safe_headers = safe_request_headers(headers_ref);

    let accept = parts
        .headers
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let wants_html = accept.contains("text/html");

    let mut html_access_token: Option<String> = None;
    let mut session_token: Option<String> = None;

    if let Ok(Some(sess)) = state.store.session() {
        session_token = Some(sess.session_token.clone());
        if wants_html {
            if let Ok(creds) = get_valid_credentials(&state.store).await {
                html_access_token = Some(creds.access_token);
            }
        }
    }

    let needs_auth_headers = path_and_query.starts_with("/backend-api/")
        || path_and_query.starts_with("/ces/")
        || path_and_query.starts_with("/api/")
        || path_and_query.starts_with("/realtime/");

    let mut auth_headers = Vec::new();
    if needs_auth_headers {
        if let Ok(creds) = get_valid_credentials(&state.store).await {
            auth_headers.push((
                "authorization".to_string(),
                format!("Bearer {}", creds.access_token),
            ));
            auth_headers.push(("oai-device-id".to_string(), creds.device_id.clone()));

            if path_and_query.starts_with("/backend-api/") {
                let target_route = path_and_query.split('?').next().unwrap_or(path_and_query);
                auth_headers.push(("x-openai-target-path".to_string(), target_route.to_string()));
                auth_headers.push((
                    "x-openai-target-route".to_string(),
                    target_route.to_string(),
                ));

                let has_acct = safe_headers.iter().any(|(k, _)| k == "chatgpt-account-id");
                if !has_acct {
                    if let Some(acct_id) = resolve_account_id_at(
                        state,
                        upstream_base,
                        &creds.access_token,
                        &creds.device_id,
                    )
                    .await
                    {
                        auth_headers.push(("chatgpt-account-id".to_string(), acct_id));
                    }
                }
            }
        }
    }

    // Build wreq request
    let upstream_url = format!("{upstream_base}{path_and_query}");
    let mut wreq_req = state.http.request(parts.method.clone(), &upstream_url);

    // Add safe headers
    for (k, v) in safe_headers {
        if let Ok(hname) = HeaderName::from_bytes(k.as_bytes()) {
            if let Ok(hval) = HeaderValue::from_str(&v) {
                wreq_req = wreq_req.header(hname, hval);
            }
        }
    }

    if let Some(ref st) = session_token {
        wreq_req = wreq_req.header("cookie", format!("__Secure-next-auth.session-token={st}"));
    }

    for (k, v) in auth_headers {
        wreq_req = wreq_req.header(k, v);
    }

    // Body
    if parts.method != Method::GET && parts.method != Method::HEAD {
        let bytes = match axum::body::to_bytes(body, 50 * 1024 * 1024).await {
            Ok(b) => b,
            Err(_) => {
                return (StatusCode::BAD_REQUEST, "Failed to read request body").into_response();
            }
        };
        if !bytes.is_empty() {
            wreq_req = wreq_req.body(bytes.to_vec());
        }
    }

    let upstream_resp = match wreq_req.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                axum::Json(json!({
                    "error": "upstream_request_failed",
                    "path": path_and_query,
                    "detail": e.to_string(),
                })),
            )
                .into_response();
        }
    };

    let status =
        StatusCode::from_u16(upstream_resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream_resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let scheme = if parts.uri.scheme_str() == Some("https") {
        "https"
    } else {
        "http"
    };
    let proxy_origin = request_origin(scheme, host);

    let is_html = content_type.contains("text/html");
    let is_rewritable = is_html || is_rewritable_content_type(&content_type);

    let mut response_builder = Response::builder().status(status);

    for (name, val) in upstream_resp.headers() {
        let lower = name.as_str().to_ascii_lowercase();
        if is_stripped_response_header(&lower) {
            continue;
        }
        let value_str = val.to_str().unwrap_or("");
        let final_value = if lower == "location" {
            if let Some(ref origin) = proxy_origin {
                rewrite_chatgpt_urls(value_str, origin)
            } else {
                value_str.to_string()
            }
        } else {
            value_str.to_string()
        };
        if let Ok(hval) = HeaderValue::from_str(&final_value) {
            response_builder = response_builder.header(name.clone(), hval);
        }
    }

    let cc = cache_control(
        path_and_query,
        &content_type,
        upstream_resp
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
    );
    response_builder = response_builder.header("cache-control", cc);
    response_builder = response_builder.header("alt-svc", "clear");

    if is_html {
        let text = upstream_resp.text().await.unwrap_or_default();
        let transformed = transform_html(
            &text,
            proxy_origin.as_deref(),
            html_access_token.as_deref(),
            EARLY_PATCH,
        );
        return response_builder
            .body(Body::from(transformed))
            .unwrap_or_default();
    }

    if is_rewritable {
        let text = upstream_resp.text().await.unwrap_or_default();
        let transformed = transform_text_asset(&text, proxy_origin.as_deref().unwrap_or(""));
        return response_builder
            .body(Body::from(transformed))
            .unwrap_or_default();
    }

    let bytes = upstream_resp.bytes().await.unwrap_or_default();
    response_builder.body(Body::from(bytes)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use mirror_store::Store;
    use mirror_store::crypto::EncryptionKey;

    fn test_store() -> Arc<Store> {
        Arc::new(
            Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap())
                .unwrap(),
        )
    }

    #[tokio::test]
    async fn proxy_rejects_unauthorized_host_or_origin() {
        let store = test_store();
        let egress = Arc::new(crate::egress::EgressMonitor::new());
        let state = Arc::new(AppState::new(store, egress));

        let req = Request::builder()
            .uri("/some/unmatched/path")
            .header("host", "evil.com")
            .body(Body::empty())
            .unwrap();

        let resp = proxy_chatgpt(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn proxy_returns_404_for_v1_routes() {
        let store = test_store();
        let egress = Arc::new(crate::egress::EgressMonitor::new());
        let state = Arc::new(AppState::new(store, egress));

        let req = Request::builder()
            .uri("/v1/unknown")
            .header("host", "localhost:8787")
            .body(Body::empty())
            .unwrap();

        let resp = proxy_chatgpt(State(state), req).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn mirror_auth_session_unauthorized_when_no_credentials() {
        let store = test_store();
        let egress = Arc::new(crate::egress::EgressMonitor::new());
        let state = AppState::new(store, egress);

        let resp = mirror_auth_session(&state).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn resolve_account_id_returns_cached_account_id() {
        let store = test_store();
        store
            .save_verified_session("token-123", Some("acct-pre-resolved"), None, None)
            .unwrap();

        let egress = Arc::new(crate::egress::EgressMonitor::new());
        let state = AppState::new(store, egress);

        let resolved = resolve_account_id(&state, "access-token", "device-id").await;
        assert_eq!(resolved.as_deref(), Some("acct-pre-resolved"));
    }
}
