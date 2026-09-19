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
use crate::decoder_challenges::ChallengeShelf;
use crate::egress::EgressMonitor;
use axum::Router;
use axum::extract::{Path, Query, State};
use axum::http::{Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures_util::TryStreamExt;
use mirror_store::conversations::NewConversation;
use mirror_store::{Page, Store};
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

#[derive(serde::Deserialize)]
struct SearchParams {
    q: String,
}

#[derive(serde::Deserialize)]
struct ExportParams {
    #[serde(default = "default_export_format")]
    format: String,
    #[serde(default)]
    attachments: bool,
    #[serde(default)]
    metadata: bool,
}

fn default_export_format() -> String {
    "json".to_string()
}

pub struct AppState {
    pub store: Arc<Store>,
    pub egress: Arc<EgressMonitor>,
    pub http: wreq::Client,
    pub challenges: ChallengeShelf,
}

impl AppState {
    pub fn new(store: Arc<Store>, egress: Arc<EgressMonitor>) -> Self {
        // Falling back to wreq's default profile would silently send upstream
        // traffic with a different TLS/HTTP identity from the one this
        // backend promises to use.
        let http = mirror_protocol::http::build_client()
            .expect("the configured upstream client must initialize");
        Self {
            store,
            egress,
            http,
            challenges: ChallengeShelf::default(),
        }
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
        .route(
            "/api/conversations/{id}/stop",
            post(stop_conversation_handler),
        )
        .route(
            "/api/conversations/{id}/branch",
            post(branch_conversation_handler),
        )
        .route("/api/chat", post(chat_handler))
        .route("/api/models", get(api_models_handler))
        .route("/api/gpts", get(api_gpts_handler))
        .route("/api/assets", get(api_assets_handler))
        .route("/api/files", post(api_files_handler))
        .route(
            "/api/asset-content",
            get(asset_content_handler).head(asset_content_handler),
        )
        .route(
            "/api/settings/default-system-instructions",
            get(get_default_instructions_handler).put(put_default_instructions_handler),
        )
        .route(
            "/api/settings/hotkeys",
            get(get_hotkeys_handler).put(put_hotkeys_handler),
        )
        .route(
            "/api/conversations/search",
            get(search_conversations_handler),
        )
        .route(
            "/api/conversations/{id}/branches",
            get(conversation_branches_handler),
        )
        .route(
            "/api/conversations/{id}/export",
            get(export_conversation_handler),
        )
        .route("/mirror/inject.css", get(inject_css_handler))
        .route("/mirror/inject.js", get(inject_js_handler))
        .route("/mirror/playground", get(playground_handler))
        .route("/mirror/openapi", get(openapi_handler))
        .route("/mirror/api-docs", get(api_docs_handler))
        .route(
            "/api/decoder-challenges",
            post(crate::decoder_challenges::create),
        )
        .route(
            "/api/decoder-challenges/kit",
            post(crate::decoder_challenges::kit),
        )
        .route(
            "/api/decoder-challenges/{id}/artifact",
            get(crate::decoder_challenges::artifact),
        )
        .route(
            "/api/decoder-challenges/{id}/verify",
            post(crate::decoder_challenges::verify),
        )
        .nest_service(
            "/mirror/assets",
            tower_http::services::ServeDir::new("./apps/web/dist/assets"),
        )
        .route("/v1/models", get(v1_models_handler))
        .route("/v1/chat/completions", post(v1_chat_completions_handler))
        .route("/v1/responses", post(v1_responses_handler))
        .route("/v1/capabilities", get(v1_capabilities_handler))
        .merge(crate::conversion_routes::conversion_routes())
        .fallback(crate::proxy::proxy_chatgpt)
        // Security checks must wrap every route, including the catch-all
        // ChatGPT proxy. Axum does not provide the Fastify onRequest hook the
        // original server relied on, so omitting this layer makes every
        // control endpoint anonymously reachable.
        .layer(middleware::from_fn(security_middleware))
        .layer(axum::extract::DefaultBodyLimit::max(30 * 1024 * 1024))
        .with_state(state)
}

fn current_account_id(store: &Store) -> Result<String, mirror_store::StoreError> {
    Ok(store
        .session()?
        .and_then(|session| session.account_id)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| "default".to_string()))
}

fn conversation_belongs_to_account(
    store: &Store,
    id: &str,
) -> Result<bool, mirror_store::StoreError> {
    let Some(conversation) = store.conversation(id)? else {
        return Ok(false);
    };
    Ok(conversation.account_id == current_account_id(store)?)
}

async fn security_middleware(request: Request<axum::body::Body>, next: Next) -> Response {
    let headers = request.headers();
    let method = request.method().as_str();
    let url = request
        .uri()
        .path_and_query()
        .map(|u| u.as_str())
        .unwrap_or("/");
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok());
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let authorization = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let cookie = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok());

    if !crate::security::is_allowed_request_host(host) {
        return (
            StatusCode::MISDIRECTED_REQUEST,
            Json(json!({"error":"Untrusted Host header"})),
        )
            .into_response();
    }

    let path = request.uri().path();
    let public_api = matches!(
        path,
        "/v1/responses" | "/v1/models" | "/v1/chat/completions" | "/v1/capabilities"
    );
    let origin_allowed = crate::security::is_allowed_origin(origin.as_deref(), host);
    if method == "OPTIONS" {
        if origin.is_some() && (origin_allowed || public_api) {
            let mut response = StatusCode::NO_CONTENT.into_response();
            apply_cors_headers(&mut response, origin.as_deref());
            return response;
        }
        return StatusCode::NO_CONTENT.into_response();
    }
    if public_api && !origin_allowed {
        let api_keys = configured_request_api_keys();
        if !crate::security::token_matches(crate::security::bearer_token(authorization), &api_keys)
        {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error":{"message":"Cross-origin API requests require a configured Mirror API key","type":"authentication_error"}}))).into_response();
        }
    } else {
        let mutating = !matches!(method, "GET" | "HEAD" | "OPTIONS");
        if mutating && !origin_allowed {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Cross-origin control request rejected"})),
            )
                .into_response();
        }
        if origin.is_some() && !origin_allowed {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Origin rejected"})),
            )
                .into_response();
        }
    }

    let accept = headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok());
    let fetch_site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    let bootstrap = crate::security::may_bootstrap_browser(method, url, accept, fetch_site);
    let health = path == "/api/health" || path.starts_with("/mirror/assets/");
    let asset_ticket = matches!(method, "GET" | "HEAD") && path == "/api/asset-content";
    let authorized =
        crate::security::token_matches(
            crate::security::bearer_token(authorization),
            &configured_request_api_keys(),
        ) || crate::security::authorized_local_request_with(authorization, cookie, &[]);
    if !bootstrap && !health && !asset_ticket && !authorized {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error":{"message":"Open Mirror in your browser or supply a configured Mirror API key","type":"authentication_error"}}))).into_response();
    }

    let mut response = next.run(request).await;
    if bootstrap && let Ok(value) = crate::security::control_cookie().parse() {
        response
            .headers_mut()
            .insert(axum::http::header::SET_COOKIE, value);
    }
    if public_api || origin_allowed {
        apply_cors_headers(&mut response, origin.as_deref());
    }
    response
}

fn apply_cors_headers(response: &mut Response, origin: Option<&str>) {
    let Some(origin) = origin.and_then(|value| value.parse().ok()) else {
        return;
    };
    let headers = response.headers_mut();
    headers.insert(axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Authorization, Content-Type".parse().unwrap(),
    );
    headers.insert(
        axum::http::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        "x-mirror-conversation-id, x-request-id".parse().unwrap(),
    );
    headers.append(axum::http::header::VARY, "Origin".parse().unwrap());
}

fn configured_request_api_keys() -> Vec<String> {
    #[allow(unused_mut)]
    let mut keys = crate::security::configured_api_keys();
    #[cfg(test)]
    keys.push("mirror-test-key".to_string());
    keys
}

async fn health_handler(State(state): State<Arc<AppState>>) -> Response {
    let session_ok = state.store.session().ok().flatten().is_some();
    let egress = state.egress.status();
    Json(json!({
        "ok": state.store.database_healthy() && (!egress.required || egress.verified),
        "storage": "sqlite",
        "configured": session_ok,
        "egress": egress,
    }))
    .into_response()
}

async fn diagnostics_handler(State(state): State<Arc<AppState>>) -> Response {
    let session = state.store.session().ok().flatten();
    let egress = state.egress.status();
    Json(json!({
        "schemaVersion": mirror_store::schema::database_schema_version_count(),
        "build": {"version":"0.1.0", "revision":std::env::var("MIRROR_BUILD_REVISION").ok().filter(|v| v.len() >= 7 && v.len() <= 40 && v.bytes().all(|b| b.is_ascii_hexdigit())).unwrap_or_else(||"development".to_string())},
        "api": {"reachable":true,"keyConfigured":!crate::security::configured_api_keys().is_empty()},
        "storage": {"engine":"sqlite","healthy":state.store.database_healthy(),"schemaVersion":mirror_store::schema::database_schema_version_count()},
        "session": {"saved":session.is_some(),"generationVerified":false},
        "nextAction": if !egress.verified {"Check the WARP container health."} else if session.is_none() {"Save a session in Mirror controls."} else {"Test model discovery, then explicitly run a generation in Playground."},
        "recentFailures": recent_failures(),
        "egress": egress,
    }))
    .into_response()
}

async fn get_session_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.store.session() {
        Ok(Some(s)) => Json(json!({"configured":true,"savedAt":s.saved_at,"hasTurnstileToken":s.turnstile_token.is_some()}))
        .into_response(),
        _ => Json(json!({"configured":false,"savedAt":null,"hasTurnstileToken":false}))
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

    let revision = state.store.session_revision();
    let client = mirror_protocol::client::ChatGptBackendClient::new(
        state.http.clone(),
        verified.credentials.clone(),
    );
    if let Err(error) = client.fetch_me().await {
        return (
            StatusCode::BAD_GATEWAY,
            Json(api_error(502, &error.to_string(), "session-verify")),
        )
            .into_response();
    }
    if let Err(error) = state.store.assert_session_revision(revision) {
        return (
            StatusCode::CONFLICT,
            Json(api_error(409, &error.to_string(), "session-verify")),
        )
            .into_response();
    }
    let account_id = client.account_id.lock().ok().and_then(|id| id.clone());
    let saved = match state.store.save_verified_session(
        &verified.persisted_session_token,
        account_id.as_deref(),
        Some(&verified.credentials.device_id),
        verified.turnstile_token.as_deref(),
    ) {
        Ok(saved) => saved,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "session-save")),
            )
                .into_response();
        }
    };
    if let Some(account_id) = account_id.as_deref() {
        let _ = state.store.claim_default_account_data(account_id);
    }
    let _ = state.store.update_minted_token(
        &verified.credentials.access_token,
        verified.expires_at,
        None,
    );

    Json(json!({
        "ok": true,
        "accountId": saved.account_id,
        "email": null,
    }))
    .into_response()
}

async fn delete_session_handler(State(state): State<Arc<AppState>>) -> Response {
    match state.store.clear_session() {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "session-delete")),
        )
            .into_response(),
    }
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

    if query.limit == 0 || query.limit > 100 || query.offset > 1_000_000 {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "limit must be 1..100 and offset must be at most 1000000",
                "list-conv",
            )),
        )
            .into_response();
    }

    if query.sync {
        let credentials = match get_valid_credentials(&state.store).await {
            Ok(credentials) => credentials,
            Err(error) => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(api_error(401, &error.to_string(), "list-conv")),
                )
                    .into_response();
            }
        };
        let http = state.http.clone();
        if let Err(error) = crate::conversation_sync::sync_conversation_page(
            &state.store,
            &account_id,
            (query.offset + query.limit) as i64,
            query.resync,
            |offset, limit, archived| {
                let client = mirror_protocol::client::ChatGptBackendClient::new(
                    http.clone(),
                    credentials.clone(),
                );
                async move {
                    client
                        .fetch_conversations(
                            Some(offset as u32),
                            Some(limit as u32),
                            Some(archived),
                        )
                        .await
                        .map(|(items, _)| {
                            items
                                .into_iter()
                                .map(|item| mirror_store::RemoteConversationSummary {
                                    id: item.id,
                                    title: item.title,
                                    create_time: item.create_time,
                                    update_time: item.update_time,
                                    current_node_id: item.current_node_id,
                                    gizmo_id: item.gizmo_id,
                                    is_archived: item.is_archived,
                                })
                                .collect()
                        })
                        .map_err(|error| error.to_string())
                }
            },
        )
        .await
        {
            return (
                StatusCode::BAD_GATEWAY,
                Json(api_error(502, &error.to_string(), "list-conv")),
            )
                .into_response();
        }
    }

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
    let has_more = query.offset + conversations.len() < total.max(0) as usize
        || crate::conversation_sync::has_remote_history(&state.store, &account_id).unwrap_or(false);

    Json(json!({
        "items": conversations,
        "total": total,
        "offset": query.offset,
        "limit": query.limit,
        "hasMore": has_more,
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

    let account = match current_account_id(&state.store) {
        Ok(account) => account,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "get-conv")),
            )
                .into_response();
        }
    };
    if conv.account_id != account {
        return (
            StatusCode::NOT_FOUND,
            Json(api_error(404, "Conversation not found", "get-conv")),
        )
            .into_response();
    }

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

    let instructions = state.store.instructions(&id).unwrap_or_default();
    Json(json!({
        "conversation": conv,
        "messages": messages,
        "instructions": instructions.iter().map(|(role, content)| json!({"role": role, "content": content})).collect::<Vec<_>>(),
    }))
    .into_response()
}

async fn patch_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ModelUpdateBody>,
) -> Response {
    match conversation_belongs_to_account(&state.store, &id) {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "patch-conv")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "patch-conv")),
            )
                .into_response();
        }
    }
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
    match conversation_belongs_to_account(&state.store, &id) {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "del-conv")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "del-conv")),
            )
                .into_response();
        }
    }
    stop_conversation(&id);
    if let Err(e) = state.store.delete_conversation(&id) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &e.to_string(), "del-conv")),
        )
            .into_response();
    }
    Json(json!({ "status": "ok" })).into_response()
}

async fn stop_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match conversation_belongs_to_account(&state.store, &id) {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "stop-conv")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "stop-conv")),
            )
                .into_response();
        }
    }
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

    match current_account_id(&state.store) {
        Ok(account) if parent.account_id == account => {}
        Ok(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "branch-conv")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "branch-conv")),
            )
                .into_response();
        }
    }
    let source_messages = match state.store.list_messages(&id) {
        Ok(messages) => messages,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "branch-conv")),
            )
                .into_response();
        }
    };
    let Some(selected) = source_messages
        .iter()
        .find(|message| message.id == body.message_id && message.upstream_node_id.is_some())
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "That message cannot be used as a branch point",
                "branch-conv",
            )),
        )
            .into_response();
    };
    let branch = match state.store.create_conversation(NewConversation {
        id: None,
        model: parent.model.clone(),
        gizmo_id: parent.gizmo_id.clone(),
        private: parent.private,
        title: body.title.or(Some("Branched chat".to_string())),
        account_id: Some(parent.account_id.clone()),
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

    let mut branch = branch;
    branch.conversation_id = parent.conversation_id.clone();
    branch.current_node_id = selected
        .upstream_node_id
        .clone()
        .unwrap_or_else(|| parent.current_node_id.clone());
    branch.initialized = parent.initialized;
    branch.init = parent.init.clone();
    branch.is_branch = true;
    if let Err(error) = state.store.update_conversation(&branch) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "branch-conv")),
        )
            .into_response();
    }
    for message in source_messages
        .iter()
        .take_while(|message| message.id != body.message_id)
        .chain(std::iter::once(selected))
    {
        if let Err(error) = state.store.add_message(
            &branch.id,
            message.upstream_node_id.as_deref(),
            &message.role,
            &message.content,
            &message.status,
            &message.events,
            Some(&message.attachments),
            None,
        ) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "branch-conv")),
            )
                .into_response();
        }
    }
    let instructions = state.store.instructions(&id).unwrap_or_default();
    let _ = state.store.save_instructions(&branch.id, &instructions);
    let instruction_values = instructions
        .iter()
        .map(|(role, content)| json!({"role":role,"content":content}))
        .collect::<Vec<_>>();
    let _ = state.store.save_openai_context(
        &branch.id,
        &mirror_store::conversations::fingerprint_value(&json!(instruction_values)),
    );
    let branch_messages = state.store.list_messages(&branch.id).unwrap_or_default();
    let transcript = instruction_values
        .into_iter()
        .chain(
            branch_messages
                .iter()
                .map(|message| json!({"role":message.role,"content":message.content})),
        )
        .collect::<Vec<_>>();
    let _ = state.store.save_openai_transcript(
        &branch.id,
        &branch.account_id,
        &mirror_store::conversations::fingerprint_value(&json!(transcript)),
    );

    Json(json!(
        state
            .store
            .conversation(&branch.id)
            .ok()
            .flatten()
            .unwrap_or(branch)
    ))
    .into_response()
}

async fn chat_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ChatBody>,
) -> Response {
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    for attachment in &body.attachments {
        if !state
            .store
            .owns_file(&attachment.file_id, &account)
            .unwrap_or(false)
        {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"One or more attachments do not belong to this account"})),
            )
                .into_response();
        }
    }
    let attachments = body
        .attachments
        .into_iter()
        .map(|attachment| mirror_protocol::types::UploadedFile {
            file_id: attachment.file_id,
            file_name: attachment.file_name,
            file_size: attachment.file_size,
            mime_type: attachment.mime_type,
            use_case: if attachment.use_case == "my_files" {
                mirror_protocol::types::UseCase::MyFiles
            } else {
                mirror_protocol::types::UseCase::Multimodal
            },
            width: attachment.width,
            height: attachment.height,
            raw: attachment.raw,
        })
        .collect();
    let turnstile = body
        .turnstile_token
        .or_else(|| {
            headers
                .get("openai-sentinel-turnstile-token")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        })
        .or_else(|| {
            headers
                .get("x-turnstile-token")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        });

    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    let cancel = tokio_util::sync::CancellationToken::new();
    let store = state.store.clone();
    let prompt = body.prompt;
    let options = RunChatOptions {
        conversation_id: body.conversation_id,
        new_conversation_id: None,
        prompt,
        model: Some(body.model),
        gizmo_id: body.gizmo_id,
        timezone: body.timezone,
        timezone_offset_min: body.timezone_offset_min,
        attachments,
        private: false,
        ephemeral: false,
        turnstile_token: turnstile,
        on_delta: Some(Box::new({
            let sender = sender.clone();
            let cancel = cancel.clone();
            move |_conversation_id, delta| {
                if sender
                    .send(format!(
                        "event: delta\ndata: {}\n\n",
                        json!({"delta":delta})
                    ))
                    .is_err()
                {
                    cancel.cancel();
                }
            }
        })),
        on_event: Some(Box::new({
            let sender = sender.clone();
            move |event| {
                let mut value = serde_json::to_value(event).unwrap_or(Value::Null);
                let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
                if value.get("displayHidden").and_then(Value::as_bool) == Some(true)
                    || matches!(kind, "raw" | "assistant_text" | "message")
                {
                    return;
                }
                if let Some(object) = value.as_object_mut() {
                    object.remove("raw");
                }
                let _ = sender.send(format!("event: event\ndata: {}\n\n", value));
            }
        })),
        cancel_token: Some(cancel.clone()),
    };
    tokio::spawn(async move {
        match run_chat(&store, options).await {
            Ok(outcome) => {
                let _ = sender.send(format!("event: done\ndata: {}\n\n", json!({
                "text":outcome.result.text,"conversationId":outcome.conversation.id,
                "upstreamConversationId":outcome.result.conversation_id,"messageId":outcome.result.message_id,
                "assistantMessageId":outcome.stored_assistant_message_id,"model":outcome.conversation.model,"init":outcome.conversation.init
            })));
            }
            Err(error) => {
                record_failure("chat_error", "api-chat", None);
                let _ = sender.send(format!(
                    "event: error\ndata: {}\n\n",
                    json!({"message":error.to_string()})
                ));
            }
        }
    });
    let body_stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| {
            (
                Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(item)),
                receiver,
            )
        })
    });
    let mut response = axum::body::Body::from_stream(body_stream).into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "text/event-stream; charset=utf-8".parse().unwrap(),
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        "no-cache, no-transform".parse().unwrap(),
    );
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}

async fn v1_models_handler(State(state): State<Arc<AppState>>) -> Response {
    let credentials = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(error) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &error.to_string(), "v1-models")),
            )
                .into_response();
        }
    };
    let client =
        mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), credentials);
    let (models, projects, gpts) = tokio::join!(
        client.fetch_models(),
        client.fetch_gizmo_sidebar(Some(50), Some(false), Some(0)),
        client.fetch_gizmo_bootstrap(Some(20))
    );
    let models = match models {
        Ok(raw) => mirror_protocol::models::normalize_models(&raw),
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(api_error(502, &error.to_string(), "v1-models")),
            )
                .into_response();
        }
    };
    let mut seen = std::collections::HashSet::new();
    let gizmos = mirror_protocol::models::normalize_gizmos(&gpts.unwrap_or_else(|_| json!({})))
        .into_iter()
        .chain(mirror_protocol::models::normalize_gizmos(
            &projects.unwrap_or_else(|_| json!({})),
        ))
        .filter(|g| seen.insert(g.id.clone()))
        .collect::<Vec<_>>();
    let data=models.into_iter().map(|model|json!({"id":model.id,"object":"model","created":0,"owned_by":"chatgpt-web","mirror":{"supported":!model.id.ends_with("-wm"),"execution_mode":if model.id.ends_with("-wm"){"unsupported_work"}else{"interactive"},"capabilities":model.capabilities}})).chain(gizmos.into_iter().map(|gizmo|json!({"id":gizmo.id,"object":"model","created":0,"owned_by":if gizmo.id.starts_with("g-p-"){"chatgpt-project"}else{"chatgpt-gizmo"},"name":gizmo.name}))).collect::<Vec<_>>();
    Json(json!({"object":"list","data":data})).into_response()
}

async fn v1_capabilities_handler() -> Response {
    Json(json!({
        "schemaVersion":1,
        "routes":["GET /v1/models","POST /v1/chat/completions","POST /v1/responses","GET /v1/capabilities"],
        "metadataFields":["conversation_id","mirror_model","private"],
        "unsupported":["tools","tool_choice","response_format","temperature","top_p","seed","n","audio","work_mode"],
        "responses":{"textInput":true,"streaming":true,"previousResponseId":false,"retrieval":false,"tools":false,"continuation":"metadata.conversation_id or full input history"},
        "usage":null,
        "conversation":{"minimalContinuation":true,"fullHistory":true,"assistantEditable":false,"streamId":"SSE comment","jsonId":"x-mirror-conversation-id"}
    })).into_response()
}

async fn v1_responses_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(input) = body.get("input") else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":{"type":"invalid_request_error","message":"input is required"}})),
        )
            .into_response();
    };
    let stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    let mut messages = Vec::new();
    if let Some(text) = input.as_str() {
        messages.push(crate::conversation_context::NormalizedMessage {
            role: "user".into(),
            content: text.to_string(),
            name: None,
        });
    } else if let Some(array) = input.as_array() {
        for item in array {
            let Some(role) = item.get("role").and_then(Value::as_str) else {
                return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","message":"input message role is required"}}))).into_response();
            };
            if !matches!(role, "system" | "developer" | "user" | "assistant") {
                return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","message":"unsupported input message role"}}))).into_response();
            }
            let content = if let Some(text) = item.get("content").and_then(Value::as_str) {
                text.to_string()
            } else if let Some(parts) = item.get("content").and_then(Value::as_array) {
                if parts.iter().any(|part| {
                    !matches!(
                        part.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text")
                    )
                }) {
                    return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"unsupported_parameter","message":"Responses input currently supports text parts only"}}))).into_response();
                }
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","message":"input message content must be text"}}))).into_response();
            };
            messages.push(crate::conversation_context::NormalizedMessage {
                role: role.to_string(),
                content,
                name: None,
            });
        }
    } else {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","message":"input must be a string or an array of messages"}}))).into_response();
    }
    if messages.is_empty() || messages.last().is_none_or(|m| m.role != "user") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error":{"type":"invalid_request_error","message":"The final input message must have role=user"}}))).into_response();
    }
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();
    let store = body.get("store").and_then(Value::as_bool).unwrap_or(true);
    let metadata = body
        .get("metadata")
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| value.as_str().map(|v| (key.clone(), v.to_string())))
                .collect::<std::collections::HashMap<_, _>>()
        })
        .unwrap_or_default();
    let routed = crate::conversation_context::route_model(&model, Some(&metadata));
    let explicit_id = metadata.get("conversation_id").cloned();
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    let prompt = crate::conversation_context::prompt_for(&messages, explicit_id.is_some());
    let instructions = body
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::to_string);
    if stream {
        let mut completion_messages = messages.clone();
        if let Some(instructions) = instructions.as_ref() {
            completion_messages.insert(
                0,
                crate::conversation_context::NormalizedMessage {
                    role: "system".into(),
                    content: instructions.clone(),
                    name: None,
                },
            );
        }
        let completion_body = json!({
            "model": model,
            "stream": true,
            "store": store,
            "metadata": body.get("metadata").cloned().unwrap_or(json!({})),
        });
        return stream_completion_request(
            state,
            completion_body,
            completion_messages,
            metadata,
            true,
            instructions,
        )
        .await;
    }
    let prompt = if let Some(instructions) = instructions {
        format!("Instructions:\n{instructions}\n\n{prompt}")
    } else {
        prompt
    };
    let outcome = match run_chat(
        &state.store,
        RunChatOptions {
            conversation_id: explicit_id.clone(),
            new_conversation_id: None,
            prompt,
            model: Some(routed.model.clone()),
            gizmo_id: routed.gizmo_id,
            timezone: None,
            timezone_offset_min: None,
            attachments: Vec::new(),
            private: routed.private.unwrap_or(false),
            ephemeral: !store,
            turnstile_token: metadata
                .get("turnstile_token")
                .cloned()
                .or_else(|| metadata.get("mirror_turnstile_token").cloned()),
            on_delta: None,
            on_event: None,
            cancel_token: None,
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let (status, error_type) = match error {
                crate::chat_service::ChatServiceError::Auth(_) => {
                    (StatusCode::UNAUTHORIZED, "authentication_error")
                }
                _ => (StatusCode::BAD_GATEWAY, "server_error"),
            };
            return (
                status,
                Json(json!({"error":{"type":error_type,"message":error.to_string()}})),
            )
                .into_response();
        }
    };
    if store {
        let _ = state.store.save_openai_transcript(
            &outcome.conversation.id,
            &account,
            &mirror_store::conversations::fingerprint_value(&json!(
                messages
                    .iter()
                    .map(|m| json!({"role":m.role,"content":m.content}))
                    .chain(std::iter::once(
                        json!({"role":"assistant","content":outcome.result.text})
                    ))
                    .collect::<Vec<_>>()
            )),
        );
    }
    let id = format!("resp_{}", Uuid::new_v4().simple());
    let item_id = format!("msg_{}", Uuid::new_v4().simple());
    let mut response_metadata = body.get("metadata").cloned().unwrap_or(json!({}));
    if let Some(object) = response_metadata.as_object_mut() {
        object.remove("turnstile_token");
        object.remove("mirror_turnstile_token");
    }
    let output = json!([{"id":item_id,"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":outcome.result.text,"annotations":[],"logprobs":[]}]}]);
    let response = json!({"id":id,"object":"response","created_at":chrono::Utc::now().timestamp(),"status":"completed","error":null,"incomplete_details":null,"model":routed.model,"output":output,"instructions":body.get("instructions").cloned().unwrap_or(Value::Null),"metadata":response_metadata,"usage":null,"store":store,"tools":[],"tool_choice":"none","parallel_tool_calls":false,"max_output_tokens":null,"previous_response_id":null});
    let mut response = Json(response).into_response();
    if let Ok(value) = outcome.conversation.id.parse() {
        response
            .headers_mut()
            .insert("x-mirror-conversation-id", value);
    }
    response
}

async fn v1_chat_completions_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let stream = body.get("stream").and_then(Value::as_bool) == Some(true);
    let Some(raw_messages) = body
        .get("messages")
        .and_then(Value::as_array)
        .filter(|m| !m.is_empty())
    else {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"messages must contain at least one message"}}))).into_response();
    };
    let mut messages = Vec::with_capacity(raw_messages.len());
    for item in raw_messages {
        let Some(role) = item.get("role").and_then(Value::as_str) else {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"message role is required"}}))).into_response();
        };
        if role == "tool" {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"unsupported_parameter","message":"Tool messages are not supported by Mirror's Chat Completions subset"}}))).into_response();
        }
        if !matches!(role, "system" | "developer" | "user" | "assistant") {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"unsupported message role"}}))).into_response();
        }
        let Some(content) = item.get("content") else {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"message content is required"}}))).into_response();
        };
        if let Some(parts) = content.as_array() {
            if parts
                .iter()
                .any(|p| p.get("type").and_then(Value::as_str) != Some("text"))
            {
                return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"unsupported_parameter","message":"This Rust port currently accepts text content parts only"}}))).into_response();
            }
        }
        messages.push(crate::conversation_context::NormalizedMessage {
            role: role.to_string(),
            content: crate::conversation_context::text_content(content),
            name: item.get("name").and_then(Value::as_str).map(str::to_string),
        });
    }
    if messages.last().is_none_or(|m| m.role != "user") {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"The final message must have role=user"}}))).into_response();
    }
    if stream {
        let metadata = body
            .get("metadata")
            .and_then(Value::as_object)
            .map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| {
                        value.as_str().map(|value| (key.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        return stream_completion_request(state, body, messages, metadata, false, None).await;
    }
    let Some(metadata) = body.get("metadata").and_then(Value::as_object) else {
        if body.get("metadata").is_some() {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"metadata must be an object of strings"}}))).into_response();
        }
        return handle_completion_request(
            state,
            body,
            messages,
            std::collections::HashMap::new(),
            None,
        )
        .await;
    };
    let metadata = metadata
        .iter()
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_string())))
        .collect::<std::collections::HashMap<_, _>>();
    handle_completion_request(state, body, messages, metadata, None).await
}

async fn handle_completion_request(
    state: Arc<AppState>,
    body: Value,
    messages: Vec<crate::conversation_context::NormalizedMessage>,
    metadata: std::collections::HashMap<String, String>,
    stream: Option<CompletionStreamWriter>,
) -> Response {
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .to_string();
    let routed = crate::conversation_context::route_model(&model, Some(&metadata));
    if routed.model.ends_with("-wm") {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"unsupported_parameter","message":"Work Mode is not supported by Mirror; select an interactive model"}}))).into_response();
    }
    let persistent = body.get("store").and_then(Value::as_bool).unwrap_or(true);
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    let explicit_id = metadata.get("conversation_id").cloned();
    let explicit = explicit_id
        .as_deref()
        .and_then(|id| state.store.conversation(id).ok().flatten());
    if explicit
        .as_ref()
        .is_some_and(|conv| conv.account_id != account)
    {
        return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":format!("metadata.conversation_id is already in use: {}",explicit_id.as_deref().unwrap_or_default())}}))).into_response();
    }
    let prior = messages
        .iter()
        .take(messages.len() - 1)
        .map(|m| json!({"role":m.role,"content":m.content}))
        .collect::<Vec<_>>();
    let prior_hash =
        (!prior.is_empty()).then(|| mirror_store::conversations::fingerprint_value(&json!(prior)));
    let inferred = if persistent && explicit_id.is_none() {
        prior_hash.as_deref().and_then(|hash| {
            state
                .store
                .find_conversation_by_transcript(&account, hash)
                .ok()
                .flatten()
        })
    } else {
        None
    };
    let active = explicit.or(inferred);
    if let Some(conversation) = active.as_ref() {
        if conversation.gizmo_id != routed.gizmo_id && routed.gizmo_id.is_some() {
            return (StatusCode::BAD_REQUEST,Json(json!({"error":{"type":"invalid_request_error","message":"The requested model does not match this conversation"}}))).into_response();
        }
    }
    let continuation = active.is_some();
    let prompt = crate::conversation_context::prompt_for(&messages, continuation);
    let instructions = messages
        .iter()
        .filter(|message| message.role == "system" || message.role == "developer")
        .map(|message| (message.role.clone(), message.content.clone()))
        .collect::<Vec<_>>();
    let turnstile = metadata
        .get("mirror_turnstile_token")
        .or_else(|| metadata.get("turnstile_token"))
        .cloned();
    let cancellation = tokio_util::sync::CancellationToken::new();
    let delta_stream = stream.clone();
    let delta_cancellation = cancellation.clone();
    let on_delta: Option<crate::chat_service::DeltaCallback> = delta_stream.map(|writer| {
        Box::new(move |delta: &str, _: &str| writer.chat_delta(delta, &delta_cancellation))
            as crate::chat_service::DeltaCallback
    });
    let outcome = match run_chat(
        &state.store,
        RunChatOptions {
            conversation_id: active.as_ref().map(|c| c.id.clone()),
            new_conversation_id: if active.is_none() {
                explicit_id.clone()
            } else {
                None
            },
            prompt,
            model: Some(routed.model.clone()),
            gizmo_id: routed.gizmo_id.clone(),
            timezone: None,
            timezone_offset_min: None,
            attachments: Vec::new(),
            private: routed.private.unwrap_or(false),
            ephemeral: !persistent,
            turnstile_token: turnstile,
            on_delta,
            on_event: None,
            cancel_token: stream.as_ref().map(|_| cancellation.clone()),
        },
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            let (status, error_type) = match error {
                crate::chat_service::ChatServiceError::Auth(_) => {
                    (StatusCode::UNAUTHORIZED, "authentication_error")
                }
                _ => (StatusCode::BAD_GATEWAY, "server_error"),
            };
            return (
                status,
                Json(json!({"error":{"type":error_type,"message":error.to_string()}})),
            )
                .into_response();
        }
    };
    if persistent {
        let _ = state
            .store
            .save_instructions(&outcome.conversation.id, &instructions);
        let instruction_hash = mirror_store::conversations::fingerprint_value(&json!(
            instructions
                .iter()
                .map(|(role, content)| json!({"role":role,"content":content}))
                .collect::<Vec<_>>()
        ));
        let _ = state
            .store
            .save_openai_context(&outcome.conversation.id, &instruction_hash);
        let transcript = messages
            .iter()
            .map(|m| json!({"role":m.role,"content":m.content}))
            .chain(std::iter::once(
                json!({"role":"assistant","content":outcome.result.text}),
            ))
            .collect::<Vec<_>>();
        let transcript_hash = mirror_store::conversations::fingerprint_value(&json!(transcript));
        let _ = state.store.save_openai_transcript(
            &outcome.conversation.id,
            &account,
            &transcript_hash,
        );
    }
    let mut response_metadata = json!({"conversation_id":outcome.conversation.id});
    for (key, value) in crate::conversation_context::build_response_metadata(
        &outcome.result.events,
        outcome.result.conversation_id.as_deref(),
    )
    .unwrap_or_default()
    {
        response_metadata[&key] = json!(value);
    }
    let now = chrono::Utc::now().timestamp();
    let id = format!("chatcmpl-{}", outcome.result.user_message_id);
    let value = json!({"id":id,"object":"chat.completion","created":now,"model":outcome.conversation.model,"choices":[{"index":0,"message":{"role":"assistant","content":outcome.result.text},"finish_reason":"stop"}],"usage":null,"metadata":response_metadata});
    let mut response = Json(value).into_response();
    if let Ok(value) = outcome.conversation.id.parse() {
        response
            .headers_mut()
            .insert("x-mirror-conversation-id", value);
    }
    response
}

#[derive(Clone)]
struct CompletionStreamWriter {
    sender: tokio::sync::mpsc::UnboundedSender<String>,
    response_api: bool,
    id: String,
    item_id: String,
    model: String,
    created: i64,
    instructions: Option<String>,
    store: bool,
    sequence: Arc<std::sync::atomic::AtomicI64>,
}

impl CompletionStreamWriter {
    fn data(&self, value: &Value) {
        let _ = self.sender.send(format!("data: {}\n\n", value));
    }

    fn response_event(&self, event_type: &str, fields: Value) {
        let mut event = fields.as_object().cloned().unwrap_or_default();
        event.insert("type".into(), json!(event_type));
        event.insert(
            "sequence_number".into(),
            json!(
                self.sequence
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ),
        );
        let _ = self.sender.send(format!(
            "event: {event_type}\ndata: {}\n\n",
            Value::Object(event)
        ));
    }

    fn chat_delta(&self, delta: &str, cancellation: &tokio_util::sync::CancellationToken) {
        if self.response_api {
            self.response_event("response.output_text.delta", json!({
                "item_id": self.item_id, "output_index": 0, "content_index": 0, "delta": delta, "logprobs": []
            }));
        } else {
            self.data(&json!({"id":self.id,"object":"chat.completion.chunk","created":self.created,"model":self.model,
                "choices":[{"index":0,"delta":{"content":delta},"finish_reason":null}]}));
        }
        if self.sender.is_closed() {
            cancellation.cancel();
        }
    }
}

async fn stream_completion_request(
    state: Arc<AppState>,
    body: Value,
    messages: Vec<crate::conversation_context::NormalizedMessage>,
    metadata: std::collections::HashMap<String, String>,
    response_api: bool,
    instructions: Option<String>,
) -> Response {
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<String>();
    let writer = CompletionStreamWriter {
        sender,
        response_api,
        id: if response_api {
            format!("resp_{}", Uuid::new_v4().simple())
        } else {
            format!("chatcmpl-{}", Uuid::new_v4().simple())
        },
        item_id: format!("msg_{}", Uuid::new_v4().simple()),
        model: body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .into(),
        created: chrono::Utc::now().timestamp(),
        instructions,
        store: body.get("store").and_then(Value::as_bool).unwrap_or(true),
        sequence: Arc::new(std::sync::atomic::AtomicI64::new(0)),
    };
    let task_writer = writer.clone();
    let safe_metadata = metadata
        .iter()
        .filter(|(key, _)| {
            key.as_str() != "turnstile_token" && key.as_str() != "mirror_turnstile_token"
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<std::collections::HashMap<_, _>>();
    tokio::spawn(async move {
        if task_writer.response_api {
            let in_progress = json!({"id":task_writer.id,"object":"response","created_at":task_writer.created,"status":"in_progress","error":null,"incomplete_details":null,
                "model":task_writer.model,"output":[],"instructions":task_writer.instructions,"metadata":safe_metadata,"usage":null,"store":task_writer.store,
                "tools":[],"tool_choice":"none","parallel_tool_calls":false,"max_output_tokens":null,"previous_response_id":null});
            task_writer.response_event("response.created", json!({"response":in_progress}));
            task_writer.response_event("response.in_progress", json!({"response":in_progress}));
            task_writer.response_event("response.output_item.added",json!({"output_index":0,"item":{"id":task_writer.item_id,"type":"message","role":"assistant","status":"in_progress","content":[]}}));
            task_writer.response_event("response.content_part.added",json!({"item_id":task_writer.item_id,"output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[],"logprobs":[]}}));
        } else {
            task_writer.data(&json!({"id":task_writer.id,"object":"chat.completion.chunk","created":task_writer.created,"model":task_writer.model,
                "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}));
        }
        let response = handle_completion_request(
            state,
            body,
            messages,
            metadata.clone(),
            Some(task_writer.clone()),
        )
        .await;
        let status = response.status();
        let conversation_id = response
            .headers()
            .get("x-mirror-conversation-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = match axum::body::to_bytes(response.into_body(), 20 * 1024 * 1024).await {
            Ok(bytes) => bytes,
            Err(_) => {
                task_writer.data(&json!({"error":{"type":"server_error","message":"Failed to read completion result"}}));
                return;
            }
        };
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(
            json!({"error":{"type":"server_error","message":"Invalid completion response"}}),
        );
        if !status.is_success() {
            let error = value
                .get("error")
                .cloned()
                .unwrap_or(json!({"type":"server_error","message":"Completion failed"}));
            if task_writer.response_api {
                task_writer.response_event("response.failed",json!({"response":{"id":task_writer.id,"object":"response","created_at":task_writer.created,"status":"failed","error":error,"incomplete_details":null,"model":task_writer.model,"output":[],"instructions":task_writer.instructions,"metadata":safe_metadata,"usage":null,"store":task_writer.store,"tools":[],"tool_choice":"none","parallel_tool_calls":false,"max_output_tokens":null,"previous_response_id":null}}));
            } else {
                task_writer.data(&json!({"error":error}));
            }
            return;
        }
        let text = value
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap_or("");
        let response_metadata = value.get("metadata").cloned().unwrap_or(json!({}));
        if task_writer.response_api {
            let part = json!({"type":"output_text","text":text,"annotations":[],"logprobs":[]});
            task_writer.response_event("response.output_text.done",json!({"item_id":task_writer.item_id,"output_index":0,"content_index":0,"text":text,"logprobs":[]}));
            task_writer.response_event("response.content_part.done",json!({"item_id":task_writer.item_id,"output_index":0,"content_index":0,"part":part}));
            task_writer.response_event("response.output_item.done",json!({"output_index":0,"item":{"id":task_writer.item_id,"type":"message","role":"assistant","status":"completed","content":[part]}}));
            let completed = json!({"id":task_writer.id,"object":"response","created_at":task_writer.created,"status":"completed","error":null,"incomplete_details":null,"model":value.get("model").cloned().unwrap_or(json!(task_writer.model)),
                "output":[{"id":task_writer.item_id,"type":"message","role":"assistant","status":"completed","content":[part]}],"instructions":task_writer.instructions,"metadata":response_metadata,"usage":null,"store":task_writer.store,
                "tools":[],"tool_choice":"none","parallel_tool_calls":false,"max_output_tokens":null,"previous_response_id":null});
            task_writer.response_event("response.completed", json!({"response":completed}));
        } else {
            if let Some(id) = conversation_id {
                let _ = task_writer
                    .sender
                    .send(format!(": mirror-conversation-id {id}\n\n"));
            }
            task_writer.data(&json!({"id":task_writer.id,"object":"chat.completion.chunk","created":task_writer.created,"model":value.get("model").cloned().unwrap_or(json!(task_writer.model)),
                "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"metadata":response_metadata}));
            let _ = task_writer.sender.send("data: [DONE]\n\n".to_string());
        }
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        tokio::select! {
            biased;
            chunk = receiver.recv() => chunk.map(|chunk| (Ok::<String, std::convert::Infallible>(chunk), receiver)),
            _ = tokio::time::sleep(std::time::Duration::from_secs(10)) => Some((Ok::<String, std::convert::Infallible>(": keepalive\n\n".to_string()), receiver)),
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(
            axum::http::header::CONTENT_TYPE,
            "text/event-stream; charset=utf-8",
        )
        .header(axum::http::header::CACHE_CONTROL, "no-cache, no-transform")
        .header(axum::http::header::CONNECTION, "keep-alive")
        .header("x-accel-buffering", "no")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
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
        [(
            axum::http::header::CONTENT_TYPE,
            "application/javascript; charset=utf-8",
        )],
        crate::mirror_controls::INJECTION_JS,
    )
        .into_response()
}

async fn playground_handler() -> Response {
    match tokio::fs::read("./apps/web/dist/index.html").await {
        Ok(bytes) => (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            bytes,
        )
            .into_response(),
        Err(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [(
                axum::http::header::CONTENT_TYPE,
                "text/plain; charset=utf-8",
            )],
            "Playground assets are not installed. Build apps/web before starting Mirror.",
        )
            .into_response(),
    }
}

async fn openapi_handler() -> Response {
    match tokio::fs::read("./apps/server/dist/openapi.json").await {
        Ok(bytes) => (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            bytes,
        )
            .into_response(),
        Err(_) => Json(
            json!({"openapi":"3.1.0","info":{"title":"Mirror API","version":"0.1.0"},"paths":{}}),
        )
        .into_response(),
    }
}

async fn api_docs_handler() -> Response {
    ([(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")], r#"<!doctype html><title>Mirror API docs</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;padding:0 1rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}</style><h1>Mirror API</h1><p>OpenAPI 3.1 document:</p><p><a href="/mirror/openapi">/mirror/openapi</a></p><pre id="doc">Loading…</pre><script>fetch('/mirror/openapi').then(r=>r.json()).then(x=>doc.textContent=JSON.stringify(x,null,2))</script>"#).into_response()
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

async fn api_files_handler(
    State(state): State<Arc<AppState>>,
    req: axum::extract::Request,
) -> Response {
    let content_type = req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let bytes = match axum::body::to_bytes(req.into_body(), 30 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(api_error(400, &e.to_string(), "api-files")),
            )
                .into_response();
        }
    };

    let multipart = match crate::upload_mime::parse_multipart_file(&content_type, &bytes) {
        Some(m) => m,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                Json(api_error(400, "No file uploaded", "api-files")),
            )
                .into_response();
        }
    };

    let creds = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(api_error(401, &e.to_string(), "api-files")),
            )
                .into_response();
        }
    };

    let client = mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), creds);
    let _ = client.fetch_me().await;

    let mime_type = crate::upload_mime::upload_mime_type(&multipart.file_name);
    let uploaded = match client
        .upload_file(&multipart.data, &multipart.file_name, mime_type, None, None)
        .await
    {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(api_error(502, &e.to_string(), "api-files")),
            )
                .into_response();
        }
    };

    let account_id = state
        .store
        .session()
        .ok()
        .flatten()
        .and_then(|s| s.account_id)
        .unwrap_or_else(|| "default".to_string());

    let public_file = json!({
        "fileId": uploaded.file_id,
        "fileName": uploaded.file_name,
        "fileSize": uploaded.file_size,
        "mimeType": uploaded.mime_type,
        "useCase": match uploaded.use_case {
            mirror_protocol::types::UseCase::Multimodal => "multimodal",
            mirror_protocol::types::UseCase::MyFiles => "my_files",
        },
        "width": uploaded.width,
        "height": uploaded.height,
    });

    let _ = state
        .store
        .save_file(&uploaded.file_id, &public_file, &account_id);

    Json(public_file).into_response()
}

async fn asset_content_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<std::collections::HashMap<String, String>>,
    method: Method,
) -> Response {
    let mut response_headers = axum::http::HeaderMap::new();
    response_headers.insert(
        axum::http::header::CACHE_CONTROL,
        "no-store".parse().unwrap(),
    );
    response_headers.insert(
        axum::http::header::REFERRER_POLICY,
        "no-referrer".parse().unwrap(),
    );
    response_headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        "nosniff".parse().unwrap(),
    );
    response_headers.insert(
        axum::http::header::CONTENT_SECURITY_POLICY,
        "default-src 'none'; sandbox".parse().unwrap(),
    );
    response_headers.insert(
        "cross-origin-resource-policy",
        "cross-origin".parse().unwrap(),
    );
    let ticket = query.get("ticket").and_then(|ticket| {
        state
            .store
            .open_asset_ticket(ticket, chrono::Utc::now().timestamp_millis())
    });
    let Some(ticket) = ticket else {
        return (StatusCode::NOT_FOUND,response_headers,Json(json!({"error":"File link expired or unavailable. Request a new file link in chat."}))).into_response();
    };
    let revision = state.store.session_revision();
    let credentials = match get_valid_credentials(&state.store).await {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                response_headers,
                Json(json!({"error":"unauthorized"})),
            )
                .into_response();
        }
    };
    let client =
        mirror_protocol::client::ChatGptBackendClient::new(state.http.clone(), credentials);
    if state.store.assert_session_revision(revision).is_err() {
        return (
            StatusCode::CONFLICT,
            response_headers,
            Json(json!({"error":"Session changed; retry with the current account"})),
        )
            .into_response();
    }
    let metadata = if let Some(path) = ticket.pointer.strip_prefix("sandbox:") {
        client
            .resolve_sandbox_download_metadata(
                path,
                ticket.conversation_id.as_deref(),
                ticket.message_id.as_deref(),
            )
            .await
    } else {
        client
            .resolve_asset_download_metadata(&ticket.pointer, ticket.conversation_id.as_deref())
            .await
    };
    let metadata = match metadata {
        Ok(m) => m,
        Err(_) => return (
            StatusCode::BAD_GATEWAY,
            response_headers,
            Json(
                json!({"error":"File is currently unavailable. Request a new file link in chat."}),
            ),
        )
            .into_response(),
    };
    if state.store.assert_session_revision(revision).is_err() {
        return (
            StatusCode::CONFLICT,
            response_headers,
            Json(json!({"error":"Session changed; retry with the current account"})),
        )
            .into_response();
    }
    let upstream=match client.fetch_asset_content(&metadata.url).await {Ok(response) if response.status().is_success()=>response,Ok(_)=>return (StatusCode::BAD_GATEWAY,response_headers,Json(json!({"error":"File is currently unavailable upstream. Request a new file link in chat."}))).into_response(),Err(_)=>return (StatusCode::BAD_GATEWAY,response_headers,Json(json!({"error":"File is currently unavailable. Request a new file link in chat."}))).into_response()};
    if state.store.assert_session_revision(revision).is_err() {
        return (
            StatusCode::CONFLICT,
            response_headers,
            Json(json!({"error":"Session changed; retry with the current account"})),
        )
            .into_response();
    }
    let mime_type = upstream
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(
            metadata
                .mime_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_ascii_lowercase();
    let preview = query.get("download").map(String::as_str) != Some("1")
        && mime_type.starts_with("image/")
        && matches!(
            mime_type.as_str(),
            "image/png"
                | "image/jpeg"
                | "image/gif"
                | "image/webp"
                | "image/avif"
                | "image/bmp"
                | "image/svg+xml"
                | "image/x-icon"
                | "image/vnd.microsoft.icon"
        );
    let file_name = metadata.file_name.unwrap_or(ticket.file_name);
    let file_name = std::path::Path::new(&file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("file");
    let ascii_name = file_name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() && c != '"' && c != '\\' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let disposition = if preview { "inline" } else { "attachment" };
    response_headers.insert(
        axum::http::header::CONTENT_TYPE,
        mime_type
            .parse()
            .unwrap_or_else(|_| "application/octet-stream".parse().unwrap()),
    );
    response_headers.insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("{disposition}; filename=\"{ascii_name}\"")
            .parse()
            .unwrap(),
    );
    if method == Method::HEAD {
        return (StatusCode::OK, response_headers, axum::body::Body::empty()).into_response();
    }
    let stream = upstream
        .bytes_stream()
        .map_err(|error| std::io::Error::other(error.to_string()));
    (
        StatusCode::OK,
        response_headers,
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

async fn get_default_instructions_handler(State(state): State<Arc<AppState>>) -> Response {
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    match state.store.default_system_instructions(&account) {
        Ok(content) => Json(json!({"content": content})).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "settings-instructions")),
        )
            .into_response(),
    }
}

async fn put_default_instructions_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(content) = body.get("content").and_then(Value::as_str) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "content must be a string",
                "settings-instructions",
            )),
        )
            .into_response();
    };
    if content.chars().count() > 20_000 {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "content must be at most 20000 characters",
                "settings-instructions",
            )),
        )
            .into_response();
    }
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    match state
        .store
        .set_default_system_instructions(&account, content)
    {
        Ok(()) => Json(json!({"content": content})).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "settings-instructions")),
        )
            .into_response(),
    }
}

async fn get_hotkeys_handler(State(state): State<Arc<AppState>>) -> Response {
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    match state.store.hotkeys(&account) {
        Ok(items) => {
            Json(json!({"hotkeys": items.into_iter().collect::<std::collections::HashMap<_, _>>()}))
                .into_response()
        }
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "settings-hotkeys")),
        )
            .into_response(),
    }
}

async fn put_hotkeys_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(values) = body.get("hotkeys").and_then(Value::as_object) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "hotkeys must be an object of strings",
                "settings-hotkeys",
            )),
        )
            .into_response();
    };
    let mut items = Vec::with_capacity(values.len());
    for (key, value) in values {
        let Some(value) = value.as_str() else {
            return (
                StatusCode::BAD_REQUEST,
                Json(api_error(
                    400,
                    "hotkeys must be an object of strings",
                    "settings-hotkeys",
                )),
            )
                .into_response();
        };
        if value.chars().count() > 60 {
            return (
                StatusCode::BAD_REQUEST,
                Json(api_error(
                    400,
                    "hotkey values must be at most 60 characters",
                    "settings-hotkeys",
                )),
            )
                .into_response();
        }
        items.push((key.clone(), value.to_string()));
    }
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    match state.store.set_hotkeys(&account, &items) {
        Ok(()) => Json(json!({"hotkeys": values})).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "settings-hotkeys")),
        )
            .into_response(),
    }
}

async fn search_conversations_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchParams>,
) -> Response {
    let query = query.q.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "q must contain 1 to 200 characters",
                "search-conv",
            )),
        )
            .into_response();
    }
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    match state.store.search_conversations(&account, query) {
        Ok(items) => Json(json!({"items": items})).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(api_error(500, &error.to_string(), "search-conv")),
        )
            .into_response(),
    }
}

async fn conversation_branches_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    let conversation = match state.store.conversation(&id) {
        Ok(Some(conversation)) if conversation.account_id == account => conversation,
        Ok(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "branches")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "branches")),
            )
                .into_response();
        }
    };
    let nodes = match state.store.list_messages(&id) {
        Ok(messages) => messages.into_iter().map(|message| json!({"id":message.id,"upstreamNodeId":message.upstream_node_id,"role":message.role,"status":message.status})).collect::<Vec<_>>(),
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(api_error(500, &error.to_string(), "branches"))).into_response(),
    };
    let items = match conversation.conversation_id.as_deref() {
        Some(upstream) => state
            .store
            .related_conversations(&account, upstream)
            .unwrap_or_default(),
        None => vec![conversation.clone()],
    };
    Json(json!({"selected":conversation.id,"parent":conversation.current_node_id,"items":items,"nodes":nodes})).into_response()
}

async fn export_conversation_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(query): Query<ExportParams>,
) -> Response {
    if !matches!(query.format.as_str(), "json" | "markdown") {
        return (
            StatusCode::BAD_REQUEST,
            Json(api_error(
                400,
                "format must be json or markdown",
                "export-conv",
            )),
        )
            .into_response();
    }
    let account = current_account_id(&state.store).unwrap_or_else(|_| "default".to_string());
    let conversation = match state.store.conversation(&id) {
        Ok(Some(conversation)) if conversation.account_id == account => conversation,
        Ok(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(api_error(404, "Conversation not found", "export-conv")),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "export-conv")),
            )
                .into_response();
        }
    };
    let messages = match state.store.list_messages(&id) {
        Ok(messages) => messages,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(api_error(500, &error.to_string(), "export-conv")),
            )
                .into_response();
        }
    };
    let instructions = state.store.instructions(&id).unwrap_or_default();
    let message_values = messages
        .iter()
        .map(|message| {
            let mut value = json!({"role":message.role,"content":message.content});
            if query.metadata {
                value["status"] = json!(message.status);
                value["createdAt"] = json!(message.created_at);
                value["upstreamNodeId"] = json!(message.upstream_node_id);
            }
            if query.attachments {
                value["attachments"] = message.attachments.clone();
            }
            value
        })
        .collect::<Vec<_>>();
    let archive = json!({"schemaVersion":1,"kind":"mirror-transcript-archive","resumableImport":false,"title":conversation.title,"instructions":instructions.iter().map(|(role,content)|json!({"role":role,"content":content})).collect::<Vec<_>>(),"messages":message_values,"metadata":if query.metadata {json!({"mirrorId":conversation.id,"upstreamId":conversation.conversation_id,"currentNodeId":conversation.current_node_id,"model":conversation.model})} else {Value::Null}});
    let filename = if query.format == "json" {
        "mirror-conversation.json"
    } else {
        "mirror-conversation.md"
    };
    let mut response = if query.format == "json" {
        Json(archive.clone()).into_response()
    } else {
        let mut text = format!(
            "# {}\n\nTranscript archive; importing this file does not create a resumable upstream thread.\n",
            conversation.title
        );
        for message in instructions
            .iter()
            .map(|(role, content)| (role.as_str(), content.as_str()))
            .chain(
                messages
                    .iter()
                    .map(|message| (message.role.as_str(), message.content.as_str())),
            )
        {
            text.push_str(&format!("\n## {}\n\n{}\n", message.0, message.1));
        }
        let mut response = text.into_response();
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            "text/markdown; charset=utf-8".parse().unwrap(),
        );
        response
    };
    response.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{filename}\"")
            .parse()
            .unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use mirror_store::crypto::EncryptionKey;
    use tower::ServiceExt;

    fn authorized(request: Request<Body>) -> Request<Body> {
        let (mut parts, body) = request.into_parts();
        parts
            .headers
            .insert("host", "localhost:8787".parse().unwrap());
        parts.headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer mirror-test-key".parse().unwrap(),
        );
        Request::from_parts(parts, body)
    }

    fn test_app_state() -> Arc<AppState> {
        let store = Arc::new(
            Store::open_in_memory(EncryptionKey::decode_configured(&"ab".repeat(32)).unwrap())
                .unwrap(),
        );
        let egress = Arc::new(EgressMonitor::new());
        Arc::new(AppState::new(store, egress))
    }

    #[tokio::test]
    async fn chat_completion_stream_writer_emits_incremental_sse_chunks() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let writer = CompletionStreamWriter {
            sender,
            response_api: false,
            id: "chatcmpl-test".into(),
            item_id: "msg-test".into(),
            model: "gpt-4o".into(),
            created: 1,
            instructions: None,
            store: true,
            sequence: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        };
        writer.chat_delta("piece", &cancellation);
        let event = receiver.recv().await.unwrap();
        assert!(event.starts_with("data: "));
        let value: Value = serde_json::from_str(event.trim_start_matches("data: ").trim()).unwrap();
        assert_eq!(value["choices"][0]["delta"]["content"], "piece");
        assert_eq!(value["model"], "gpt-4o");
    }

    #[tokio::test]
    async fn responses_stream_writer_numbers_lifecycle_events_monotonically() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let writer = CompletionStreamWriter {
            sender,
            response_api: true,
            id: "resp-test".into(),
            item_id: "msg-test".into(),
            model: "gpt-4o".into(),
            created: 1,
            instructions: None,
            store: true,
            sequence: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        };
        writer.response_event("response.created", json!({"response":{}}));
        writer.response_event("response.in_progress", json!({"response":{}}));
        let first = receiver.recv().await.unwrap();
        let second = receiver.recv().await.unwrap();
        assert!(first.starts_with("event: response.created\n"));
        assert!(second.starts_with("event: response.in_progress\n"));
        assert!(first.contains("\"sequence_number\":0"));
        assert!(second.contains("\"sequence_number\":1"));
    }

    #[tokio::test]
    async fn health_and_diagnostics_routes_respond() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/api/health")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .uri("/api/diagnostics")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn security_layer_rejects_untrusted_hosts_and_unauthenticated_control_routes() {
        let app = create_router(test_app_state());
        let untrusted = Request::builder()
            .uri("/api/session")
            .header("host", "attacker.example")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.clone().oneshot(untrusted).await.unwrap();
        assert_eq!(response.status(), StatusCode::MISDIRECTED_REQUEST);

        let unauthenticated = Request::builder()
            .uri("/api/session")
            .header("host", "localhost:8787")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(unauthenticated).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn session_routes_get_and_delete() {
        let state = test_app_state();
        let app = create_router(state);

        let req = Request::builder()
            .uri("/api/session")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .method("DELETE")
            .uri("/api/session")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn conversation_crud_routes() {
        let state = test_app_state();
        let app = create_router(state);

        // List
        let req = Request::builder()
            .uri("/api/conversations?sync=false")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Create
        let req = Request::builder()
            .method("POST")
            .uri("/api/conversations")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-4o"}"#))
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
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
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Patch model
        let req = Request::builder()
            .method("PATCH")
            .uri(format!("/api/conversations/{conv_id}"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-4o-mini"}"#))
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Branch
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/conversations/{conv_id}/branch"))
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"messageId":"00000000-0000-0000-0000-000000000000"}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Stop
        let req = Request::builder()
            .method("POST")
            .uri(format!("/api/conversations/{conv_id}/stop"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // Delete
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/conversations/{conv_id}"))
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
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
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        // Empty completions request fails with 400
        let req = Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"messages":[]}"#))
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let req = Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"stream":true,"messages":[{"role":"user","content":"hi"}]}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            resp.headers()[axum::http::header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let events = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(events.contains("chat.completion.chunk"));
        assert!(events.contains("authentication_error"));

        let req = Request::builder()
            .method("POST")
            .uri("/v1/responses")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"input":"hi","stream":true}"#))
            .unwrap();
        let resp = app.oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let events = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(events.contains("event: response.created"));
        assert!(events.contains("event: response.failed"));
        assert!(events.contains("sequence_number"));
    }

    #[tokio::test]
    async fn inject_css_and_js_routes_respond() {
        let state = test_app_state();
        let app = create_router(state);

        let req_css = Request::builder()
            .uri("/mirror/inject.css")
            .body(Body::empty())
            .unwrap();
        let resp_css = app.clone().oneshot(authorized(req_css)).await.unwrap();
        assert_eq!(resp_css.status(), StatusCode::OK);
        assert_eq!(
            resp_css.headers().get("content-type").unwrap(),
            "text/css; charset=utf-8"
        );

        let req_js = Request::builder()
            .uri("/mirror/inject.js")
            .body(Body::empty())
            .unwrap();
        let resp_js = app.oneshot(authorized(req_js)).await.unwrap();
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
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

        let req2 = Request::builder()
            .uri("/api/gpts")
            .body(Body::empty())
            .unwrap();
        let resp2 = app.oneshot(authorized(req2)).await.unwrap();
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
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // File service pointer for non-existent file -> 404
        let req2 = Request::builder()
            .uri("/api/assets?pointer=file-service://non-existent-id")
            .body(Body::empty())
            .unwrap();
        let resp2 = app.clone().oneshot(authorized(req2)).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::NOT_FOUND);

        // Sediment pointer without upstream conversation -> 404
        let req3 = Request::builder()
            .uri("/api/assets?pointer=sediment://some-pointer")
            .body(Body::empty())
            .unwrap();
        let resp3 = app.oneshot(authorized(req3)).await.unwrap();
        assert_eq!(resp3.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn api_files_validation() {
        let state = test_app_state();
        let app = create_router(state);

        // Missing file body -> 400
        let req = Request::builder()
            .method("POST")
            .uri("/api/files")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(authorized(req)).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // Valid multipart format but no session -> 401
        let boundary = "boundary123";
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"test.txt\"\r\nContent-Type: text/plain\r\n\r\nHello World\r\n--{boundary}--\r\n"
        );
        let req2 = Request::builder()
            .method("POST")
            .uri("/api/files")
            .header("content-type", content_type)
            .body(Body::from(body))
            .unwrap();
        let resp2 = app.oneshot(authorized(req2)).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn chat_handler_and_v1_completions_without_session_returns_error() {
        let state = test_app_state();
        let app = create_router(state);

        let req_chat = Request::builder()
            .method("POST")
            .uri("/api/chat")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"prompt":"hi","model":"auto"}"#))
            .unwrap();
        let resp_chat = app.clone().oneshot(authorized(req_chat)).await.unwrap();
        assert_eq!(resp_chat.status(), StatusCode::OK);
        assert!(
            resp_chat
                .headers()
                .get(axum::http::header::CONTENT_TYPE)
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );

        let req_v1 = Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header("content-type", "application/json")
            .body(Body::from(
                r#"{"messages":[{"role":"user","content":"hi"}]}"#,
            ))
            .unwrap();
        let resp_v1 = app.oneshot(authorized(req_v1)).await.unwrap();
        assert_eq!(resp_v1.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn conversation_not_found_errors() {
        let state = test_app_state();
        let app = create_router(state);

        let req_patch = Request::builder()
            .method("PATCH")
            .uri("/api/conversations/non-existent-uuid")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"model":"gpt-4o"}"#))
            .unwrap();
        let resp_patch = app.clone().oneshot(authorized(req_patch)).await.unwrap();
        assert_eq!(resp_patch.status(), StatusCode::NOT_FOUND);

        let req_branch = Request::builder()
            .method("POST")
            .uri("/api/conversations/non-existent-uuid/branch")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"messageId":"msg-123"}"#))
            .unwrap();
        let resp_branch = app.oneshot(authorized(req_branch)).await.unwrap();
        assert_eq!(resp_branch.status(), StatusCode::NOT_FOUND);
    }
}
