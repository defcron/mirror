//! Axum HTTP application router for Mirror.
//! Implements `/api/*`, `/v1/*`, and `/mirror/*` routes.

#![allow(clippy::collapsible_if)]

use crate::api_errors::{api_error, recent_failures, record_failure};
use crate::api_schemas::{
    AssetsQuery, BranchBody, ChatBody, ConversationsQuery, ModelUpdateBody, NewConversationBody,
    SetSessionBody,
};
use crate::auth::{get_valid_credentials, verify_candidate_session_token};
use crate::chat_service::{RunChatOptions, run_chat, stop_conversation};
use crate::egress::EgressMonitor;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use mirror_store::conversations::NewConversation;
use mirror_store::{Page, Store};
use serde_json::{Value, json};
use std::sync::Arc;

pub struct AppState {
    pub store: Arc<Store>,
    pub egress: Arc<EgressMonitor>,
    pub http: wreq::Client,
}

impl AppState {
    pub fn new(store: Arc<Store>, egress: Arc<EgressMonitor>) -> Self {
        let http = mirror_protocol::http::build_client().unwrap_or_default();
        Self { store, egress, http }
    }
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/diagnostics", get(diagnostics_handler))
        .route(
            "/api/session",
            get(get_session_handler)
                .post(post_session_handler)
                .delete(delete_session_handler),
        )
        .route(
            "/api/conversations",
            get(list_conversations_handler).post(create_conversation_handler),
        )
        .route(
            "/api/conversations/{id}",
            get(get_conversation_handler)
                .patch(patch_conversation_handler)
                .delete(delete_conversation_handler),
        )
        .route("/api/conversations/{id}/stop", post(stop_conversation_handler))
        .route("/api/conversations/{id}/branch", post(branch_conversation_handler))
        .route("/api/chat", post(chat_handler))
        .route("/api/models", get(api_models_handler))
        .route("/api/gpts", get(api_gpts_handler))
        .route("/api/assets", get(api_assets_handler))
        .route("/mirror/inject.css", get(inject_css_handler))
        .route("/mirror/inject.js", get(inject_js_handler))
        .route("/v1/models", get(v1_models_handler))
        .route("/v1/chat/completions", post(v1_chat_completions_handler))
        .merge(crate::conversion_routes::conversion_routes())
        .fallback(crate::proxy::proxy_chatgpt)
        .with_state(state)
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Response {
    let session_ok = state.store.session().ok().flatten().is_some();
    Json(json!({
        "status": "ok",
        "authenticated": session_ok,
        "egress": state.egress.status(),
    }))
    .into_response()
}

async fn diagnostics_handler(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({
        "recentFailures": recent_failures(),
        "egress": state.egress.status(),
    }))
    .into_response()
}

async fn get_session_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.store.session() {
        Ok(Some(s)) => Json(json!({
            "authenticated": true,
            "accountId": s.account_id,
            "deviceId": s.device_id,
        }))
        .into_response(),
        _ => Json(json!({
            "authenticated": false,
            "accountId": null,
            "deviceId": null,
        }))
        .into_response(),
    }
}

async fn post_session_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<SetSessionBody>,
) -> Response {
    let verified = match verify_candidate_session_token(
        &body.session_token,
        body.turnstile_token,
        &state.store,
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &e.to_string(), "session-init")),
            )
                .into_response();
        }
    };

    if let Err(e) = state.store.save_verified_session(
        &verified.persisted_session_token,
        None,
        Some(&verified.credentials.device_id),
        verified.turnstile_token.as_deref(),
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &e.to_string(), "session-save")),
        )
            .into_response();
    }

    Json(json!({
        "status": "ok",
        "authenticated": true,
        "deviceId": verified.credentials.device_id,
    }))
    .into_response()
}

async fn delete_session_handler(State(state): State<Arc<AppState>>) -> Response {
    let _ = state.store.clear_session();
    Json(json!({ "status": "ok" })).into_response()
}

async fn list_conversations_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ConversationsQuery>,
) -> Response {
    let session = match state.store.session() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "list-conv")),
            )
                .into_response();
        }
    };
    let account_id = session
        .as_ref()
        .and_then(|s| s.account_id.clone())
        .unwrap_or_else(|| "default".to_string());

    let conversations = match state.store.list_conversations(
        &account_id,
        Some(Page {
            limit: query.limit as i64,
            offset: query.offset as i64,
        }),
    ) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "list-conv")),
            )
                .into_response();
        }
    };

    let total = state
        .store
        .count_conversations(&account_id)
        .unwrap_or(conversations.len() as i64);

    Json(json!({
        "items": conversations,
        "total": total,
        "offset": query.offset,
        "limit": query.limit,
    }))
    .into_response()
}

async fn create_conversation_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NewConversationBody>,
) -> Response {
    let session = match state.store.session() {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "create-conv")),
            )
                .into_response();
        }
    };
    let account_id = session
        .as_ref()
        .and_then(|s| s.account_id.clone())
        .unwrap_or_else(|| "default".to_string());

    let conv = match state.store.create_conversation(NewConversation {
        id: None,
        model: body.model,
        gizmo_id: body.gizmo_id,
        private: false,
        title: Some("New chat".to_string()),
        account_id: Some(account_id),
    }) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "create-conv")),
            )
                .into_response();
        }
    };

    Json(json!(conv)).into_response()
}

async fn get_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let conv = match state.store.conversation(&id) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "get-conv")),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "get-conv")),
            )
                .into_response();
        }
    };

    let messages = match state.store.list_messages(&id) {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "get-conv")),
            )
                .into_response();
        }
    };

    Json(json!({
        "conversation": conv,
        "messages": messages,
    }))
    .into_response()
}

async fn patch_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ModelUpdateBody>,
) -> Response {
    let conv = match state.store.set_conversation_model(&id, &body.model) {
        Ok(Some(c)) => c,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "patch-conv")),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "patch-conv")),
            )
                .into_response();
        }
    };

    Json(json!(conv)).into_response()
}

async fn delete_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(e) = state.store.delete_conversation(&id) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &e.to_string(), "del-conv")),
        )
            .into_response();
    }
    Json(json!({ "status": "ok" })).into_response()
}

async fn stop_conversation_handler(Path(id): Path<String>) -> Response {
    let stopped = stop_conversation(&id);
    Json(json!({ "status": if stopped { "stopped" } else { "idle" } })).into_response()
}

async fn branch_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<BranchBody>,
) -> Response {
    let parent = match state.store.conversation(&id) {
        Ok(Some(p)) => p,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "branch-conv")),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "branch-conv")),
            )
                .into_response();
        }
    };

    let branch = match state.store.create_conversation(NewConversation {
        id: None,
        model: parent.model,
        gizmo_id: parent.gizmo_id,
        private: parent.private,
        title: body.title.or(Some(format!("Branch of {}", parent.title))),
        account_id: Some(parent.account_id),
    }) {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "branch-conv")),
            )
                .into_response();
        }
    };

    Json(json!(branch)).into_response()
}

async fn chat_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ChatBody>,
) -> Response {
    let opts = RunChatOptions {
        conversation_id: body.conversation_id,
        new_conversation_id: None,
        prompt: body.prompt,
        model: Some(body.model),
        gizmo_id: body.gizmo_id,
        timezone: body.timezone,
        timezone_offset_min: body.timezone_offset_min,
        attachments: Vec::new(),
        private: false,
        ephemeral: false,
        turnstile_token: body.turnstile_token,
        on_delta: None,
        on_event: None,
        cancel_token: None,
    };

    match run_chat(&state.store, opts).await {
        Ok(outcome) => Json(json!({
            "conversation": outcome.conversation,
            "message": outcome.result.text,
            "messageId": outcome.stored_assistant_message_id,
        }))
        .into_response(),
        Err(e) => {
            record_failure("chat_error", "api-chat", None);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &e.to_string(), "api-chat")),
            )
                .into_response()
        }
    }
}

async fn v1_models_handler() -> Response {
    Json(json!({
        "object": "list",
        "data": [
            {
                "id": "gpt-4o",
                "object": "model",
                "created": 1715367049,
                "owned_by": "openai"
            },
            {
                "id": "auto",
                "object": "model",
                "created": 1715367049,
                "owned_by": "openai"
            }
        ]
    }))
    .into_response()
}

async fn v1_chat_completions_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let prompt = body
        .get("messages")
        .and_then(Value::as_array)
        .and_then(|msgs| msgs.last())
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if prompt.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(400, "messages array must contain at least one message with content", "v1-completions")),
        ).into_response();
    }

    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();

    let opts = RunChatOptions {
        conversation_id: None,
        new_conversation_id: None,
        prompt,
        model: Some(model.clone()),
        gizmo_id: None,
        timezone: None,
        timezone_offset_min: None,
        attachments: Vec::new(),
        private: true,
        ephemeral: true,
        turnstile_token: None,
        on_delta: None,
        on_event: None,
        cancel_token: None,
    };

    match run_chat(&state.store, opts).await {
        Ok(outcome) => {
            let now_secs = chrono::Utc::now().timestamp();
            Json(json!({
                "id": format!("chatcmpl-{}", outcome.result.user_message_id),
                "object": "chat.completion",
                "created": now_secs,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": outcome.result.text,
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0,
                }
            }))
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &e.to_string(), "v1-completions")),
        )
            .into_response(),
    }
}

async fn inject_css_handler() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "text/css; charset=utf-8")],
        crate::mirror_controls::INJECTION_CSS,
    )
        .into_response()
}

async fn inject_js_handler() -> Response {
    (
        [(axum::http::header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        crate::mirror_controls::INJECTION_JS,
    )
        .into_response()
}

async fn api_models_handler(State(state): State<Arc<AppState>>) -> Response {
    let creds = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &e.to_string(), "api-models")),
            )
                .into_response();
        }
    };

    let client = mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), creds);
    match client.fetch_models().await {
        Ok(raw) => {
            let normalized = mirror_protocol::models::normalize_models(&raw);
            let mut list = Vec::new();
            for m in normalized {
                list.push(json!({
                    "id": m.id,
                    "title": m.title,
                    "description": m.description,
                    "maxTokens": m.max_tokens,
                    "capabilities": m.capabilities,
                    "enabledTools": m.enabled_tools,
                }));
            }
            Json(list).into_response()
        }
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(api_error(502, &e.to_string(), "api-models")),
        )
            .into_response(),
    }
}

async fn api_gpts_handler(State(state): State<Arc<AppState>>) -> Response {
    let creds = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &e.to_string(), "api-gpts")),
            )
                .into_response();
        }
    };

    let client = mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), creds);
    let (sidebar_res, bootstrap_res) = tokio::join!(
        client.fetch_gizmo_sidebar(Some(50), Some(false), Some(0)),
        client.fetch_gizmo_bootstrap(Some(20))
    );

    let sidebar = sidebar_res.unwrap_or(Value::Null);
    let bootstrap = bootstrap_res.unwrap_or(Value::Null);

    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();

    for g in mirror_protocol::models::normalize_gizmos(&bootstrap)
        .into_iter()
        .chain(mirror_protocol::models::normalize_gizmos(&sidebar))
    {
        if seen.insert(g.id.clone()) {
            result.push(json!({
                "id": g.id,
                "name": g.name,
                "description": g.description,
                "shortUrl": g.short_url,
                "iconUrl": g.icon_url,
                "filesCount": g.files_count,
            }));
        }
    }

    Json(result).into_response()
}

async fn api_assets_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AssetsQuery>,
) -> Response {
    let pointer = &query.pointer;
    if !pointer.starts_with("file-service://") && !pointer.starts_with("sediment://") {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(400, "Unsupported asset pointer", "assets")),
        )
            .into_response();
    }

    let account_id = state
        .store
        .session()
        .ok()
        .flatten()
        .and_then(|s| s.account_id)
        .unwrap_or_else(|| "default".to_string());
    if let Some(file_id) = pointer.strip_prefix("file-service://") {
        if !state.store.owns_file(file_id, &account_id).unwrap_or(false) {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "File not found", "assets")),
            )
                .into_response();
        }
    }

    if pointer.starts_with("sediment://") {
        match &query.upstream_conversation_id {
            Some(conv_id)
                if state
                    .store
                    .owns_upstream_conversation(conv_id, &account_id)
                    .unwrap_or(false) => {}
            _ => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(api_error(404, "Conversation asset not found", "assets")),
                )
                    .into_response();
            }
        }
    }

    let creds = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &e.to_string(), "assets")),
            )
                .into_response();
        }
    };

    let client = mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), creds);
    match client
        .resolve_asset_download(pointer, query.upstream_conversation_id.as_deref())
        .await
    {
        Ok(url) => axum::response::Redirect::temporary(&url).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(api_error(502, &e.to_string(), "assets")),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use mirror_store::crypto::EncryptionKey;
    use tower::ServiceExt;

    fn test_app_state() -> Arc<AppState> {
        let store = Arc::new(
            Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap())
                .unwrap(),
        );
        let egress = Arc::new(EgressMonitor::new());
        Arc::new(AppState::new(store, egress))
    }

    #[tokio::test]
    async fn health_and_diagnostics_routes_respond() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/api/health")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .uri("/api/diagnostics")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn session_routes_get_and_delete() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/api/session")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .method("DELETE")
            .uri("/api/session")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn conversation_crud_routes() {
        let state = test_app_state();
        let app = create_router(state);

        // List
        let req = Request::builder()
            .uri("/api/conversations")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Create
        let req = Request::builder()
            .method("POST")
            .uri("/api/conversations")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-4o"}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let conv: Value = serde_json::from_slice(&bytes).unwrap();
        let conv_id = conv["id"].as_str().unwrap();

        // Get
        let req = Request::builder()
            .uri(format!("/api/conversations/{conv_id}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Patch model
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/conversations/{conv_id}"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-4o-mini"}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Branch
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/conversations/{conv_id}/branch"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"messageId":"00000000-0000-0000-0000-000000000000"}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Stop
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/conversations/{conv_id}/stop"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Delete
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/conversations/{conv_id}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn v1_models_and_completions_validation() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Empty completions request fails with 400
        let req = Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"messages":[]}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn inject_css_and_js_routes_respond() {
        let state = test_app_state();
        let app = create_router(state);

        let req_css = Request::builder()
            .uri("/mirror/inject.css")
            .body(Body::empty())
            .unwrap();
        let resp_css = app.clone().oneshot(req_css).await.unwrap();
        assert_eq!(resp_css.status(), StatusCode::OK);
        assert_eq!(
            resp_css.headers().get("content-type").unwrap(),
            "text/css; charset=utf-8"
        );

        let req_js = Request::builder()
            .uri("/mirror/inject.js")
            .body(Body::empty())
            .unwrap();
        let resp_js = app.oneshot(req_js).await.unwrap();
        assert_eq!(resp_js.status(), StatusCode::OK);
        assert_eq!(
            resp_js.headers().get("content-type").unwrap(),
            "application/javascript; charset=utf-8"
        );
    }

    #[tokio::test]
    async fn api_models_and_gpts_unauthorized_when_no_session() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/api/models")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let req2 = Request::builder()
            .uri("/api/gpts")
            .body(Body::empty())
            .unwrap();
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn api_assets_validation() {
        let state = test_app_state();
        let app = create_router(state);

        // Invalid pointer scheme -> 400
        let req = Request::builder()
            .uri("/api/assets?pointer=http://example.com/asset.png")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // File service pointer for non-existent file -> 404
        let req2 = Request::builder()
            .uri("/api/assets?pointer=file-service://non-existent-id")
            .body(Body::empty())
            .unwrap();
        let resp2 = app.clone().oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::NOT_FOUND);

        // Sediment pointer without upstream conversation -> 404
        let req3 = Request::builder()
            .uri("/api/assets?pointer=sediment://some-pointer")
            .body(Body::empty())
            .unwrap();
        let resp3 = app.oneshot(req3).await.unwrap();
        assert_eq!(resp3.status(), StatusCode::NOT_FOUND);
    }
}
