//! ChatGPT Web backend client — port of `packages/protocol/src/client.ts`.
//!
//! This module contains wire-protocol behavior only; product concerns
//! (persistence, OpenAI compatibility, UI, multi-user policy) stay outside,
//! matching the original's own stated scope.
//!
//! Request-shape construction (`mode_for`, `common_context`,
//! `build_user_message`, the asset-redirect SSRF guard) is split out as pure
//! functions so it can be verified against the real TS output without a live
//! backend; each has a fixture test below pinned from Node. The HTTP-calling
//! methods build on top of these and are structurally faithful to the
//! original's request/header/URL construction, but — unlike the rest of this
//! crate — cannot be round-tripped against a live `chatgpt.com` in an
//! automated, credential-free test suite.

use crate::events::NormalizedConversationEvent;
use crate::proof::{self, GenerateProofOptions, ProofConfig};
use crate::reducer::{ConversationStreamReducer, ReducerOptions};
use crate::sse::{SseFrameDecoder, iter_sse_data_lines};
use crate::types::{
    BackendApiError, ConversationInitResult, ConversationSessionState, RemoteConversationSummary,
    SendMessageResult, SessionCredentials, UploadedFile, UseCase,
};
use serde_json::{Map, Value, json};
use std::sync::atomic::AtomicBool;
use uuid::Uuid;

const ORIGIN: &str = "https://chatgpt.com";
const BASE_URL: &str = "https://chatgpt.com/backend-api";

/// Statuses `prepareFollowup` treats as "this prepare wasn't accepted, but
/// the turn can still proceed" rather than a hard failure.
const TOLERATED_PREPARE_STATUSES: [u16; 4] = [400, 404, 409, 422];

fn is_object(value: &Value) -> bool {
    value.is_object()
}

/// Mirrors `safeJson`: `null` for an empty string or invalid JSON, never a
/// thrown error.
fn safe_json(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

/// Mirrors `modeFor`.
pub fn mode_for(gizmo_id: Option<&str>, gizmo_payload: Option<&Value>) -> Value {
    let Some(gizmo_id) = gizmo_id.filter(|id| !id.is_empty()) else {
        return json!({"kind": "primary_assistant"});
    };
    let mut object = Map::new();
    object.insert("kind".to_string(), json!("gizmo_interaction"));
    object.insert("gizmo_id".to_string(), json!(gizmo_id));
    if let Some(payload) = gizmo_payload {
        object.insert("gizmo".to_string(), payload.clone());
    }
    Value::Object(object)
}

/// Mirrors `commonContext`.
pub fn common_context() -> Value {
    json!({
        "system_hints": [],
        "model_response_contracts": [{
            "id": "photo_upload_action.v1",
            "protocol_version": 1,
            "presets": ["cap:image", "cap:file", "placement:end"],
        }],
        "supports_buffering": true,
        "supported_encodings": ["v1"],
        "client_contextual_info": {
            "app_name": "chatgpt.com",
            "has_web_push_capabilities": false,
            "web_push_notification_permission": "default",
        },
        "local_function_names": ["local.continue_in_work"],
    })
}

/// Mirrors `buildUserMessage`. `create_time_secs` is epoch seconds
/// (`Date.now() / 1000` in the original); passed in rather than sampled here
/// so the function stays pure and testable.
pub fn build_user_message(
    prompt: &str,
    attachments: &[UploadedFile],
    user_message_id: &str,
    create_time_secs: f64,
) -> Value {
    if attachments.is_empty() {
        return json!({
            "id": user_message_id,
            "author": {"role": "user"},
            "create_time": create_time_secs,
            "content": {"content_type": "text", "parts": [prompt]},
            "metadata": {},
        });
    }

    let mut parts: Vec<Value> = attachments
        .iter()
        .map(|file| {
            let mut part = Map::new();
            part.insert(
                "asset_pointer".to_string(),
                json!(format!("file-service://{}", file.file_id)),
            );
            part.insert("size_bytes".to_string(), json!(file.file_size));
            if let Some(w) = file.width {
                part.insert("width".to_string(), json!(w));
            }
            if let Some(h) = file.height {
                part.insert("height".to_string(), json!(h));
            }
            Value::Object(part)
        })
        .collect();
    parts.push(json!(prompt));

    let attachment_entries: Vec<Value> = attachments
        .iter()
        .map(|file| {
            let mut entry = Map::new();
            entry.insert("id".to_string(), json!(file.file_id));
            entry.insert("mimeType".to_string(), json!(file.mime_type));
            entry.insert("name".to_string(), json!(file.file_name));
            entry.insert("size".to_string(), json!(file.file_size));
            if let Some(w) = file.width {
                entry.insert("width".to_string(), json!(w));
            }
            if let Some(h) = file.height {
                entry.insert("height".to_string(), json!(h));
            }
            Value::Object(entry)
        })
        .collect();

    json!({
        "id": user_message_id,
        "author": {"role": "user"},
        "create_time": create_time_secs,
        "content": {"content_type": "multimodal_text", "parts": parts},
        "metadata": {
            "serialization_metadata": {"custom_symbol_offsets": []},
            "attachments": attachment_entries,
        },
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssetDownload {
    pub url: String,
    pub file_name: Option<String>,
    pub mime_type: Option<String>,
}

/// Mirrors `assetDownload`.
fn asset_download(json: &Value) -> Result<AssetDownload, BackendApiError> {
    let url = json
        .get("download_url")
        .and_then(Value::as_str)
        .ok_or_else(|| BackendApiError::new("Asset metadata returned no download_url"))?;
    Ok(AssetDownload {
        url: url.to_string(),
        file_name: json.get("file_name").and_then(Value::as_str).map(str::to_string),
        mime_type: json.get("mime_type").and_then(Value::as_str).map(str::to_string),
    })
}

/// The result of validating one hop of an asset-redirect chain, mirroring
/// the `estuary`/`cdn`/rejection logic inside `fetchAssetContent`.
///
/// Estuary URLs need upstream authentication even when they carry a
/// signature; this must never be forwarded to a CDN or an arbitrary
/// redirect target, which is exactly what keeping `is_estuary` a distinct,
/// checked fact (rather than "any allowed host gets auth headers") prevents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetHopClassification {
    pub is_estuary: bool,
    pub is_cdn: bool,
    pub is_allowed: bool,
}

/// Mirrors the per-hop check in `fetchAssetContent`: only plain HTTPS with no
/// userinfo and no explicit port, to either Mirror's own `/backend-api/
/// estuary/content` origin or a known OpenAI CDN host.
pub fn classify_asset_hop(url: &url::Url) -> AssetHopClassification {
    let is_estuary = url.origin() == url::Url::parse(ORIGIN).unwrap().origin()
        && url.path() == "/backend-api/estuary/content";
    let host = url.host_str().unwrap_or("");
    let is_cdn = host.ends_with(".oaiusercontent.com")
        || host == "oaiusercontent.com"
        || host.ends_with(".blob.core.windows.net");
    let has_userinfo = !url.username().is_empty() || url.password().is_some();
    let is_allowed = url.scheme() == "https"
        && !has_userinfo
        && url.port().is_none()
        && (is_estuary || is_cdn);
    AssetHopClassification {
        is_estuary,
        is_cdn,
        is_allowed,
    }
}

/// Mirrors `fetchConversations`'s item-mapping, minus the network call:
/// filters to entries with a string `id`, defaulting title/timestamps.
pub fn map_conversation_summary(item: &Value, now_iso: &str) -> Option<RemoteConversationSummary> {
    let id = item.get("id").and_then(Value::as_str)?.to_string();
    let create_time = item
        .get("create_time")
        .map(|v| coerce_to_string(v))
        .unwrap_or_else(|| now_iso.to_string());
    let update_time = item
        .get("update_time")
        .map(|v| coerce_to_string(v))
        .or_else(|| item.get("create_time").map(|v| coerce_to_string(v)))
        .unwrap_or_else(|| now_iso.to_string());
    Some(RemoteConversationSummary {
        id,
        title: item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("New chat")
            .to_string(),
        create_time,
        update_time,
        current_node_id: item.get("current_node").and_then(Value::as_str).map(str::to_string),
        gizmo_id: item.get("gizmo_id").and_then(Value::as_str).map(str::to_string),
        is_archived: item.get("is_archived") == Some(&Value::Bool(true)),
    })
}

/// Mirrors JS's `String(value)` for the handful of scalar shapes this field
/// can hold.
fn coerce_to_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Matches `new Date().toISOString()`'s millisecond-precision UTC form,
/// used as the fallback timestamp for a conversation summary missing one.
fn iso_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let millis = now.as_millis();
    let secs = (millis / 1000) as i64;
    let ms = (millis % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Howard Hinnant's `civil_from_days`.
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

pub struct ChatGptBackendClient {
    http: wreq::Client,
    creds: std::sync::Mutex<SessionCredentials>,
    pub account_id: std::sync::Mutex<Option<String>>,
    /// Set once a request has ever seen a rotated device/account context;
    /// exposed for parity with the TS field's mutability, not currently
    /// read elsewhere.
    _reserved: AtomicBool,
}

impl ChatGptBackendClient {
    pub fn new(http: wreq::Client, creds: SessionCredentials) -> Self {
        Self {
            http,
            creds: std::sync::Mutex::new(creds),
            account_id: std::sync::Mutex::new(None),
            _reserved: AtomicBool::new(false),
        }
    }

    fn access_token(&self) -> String {
        self.creds.lock().expect("creds mutex").access_token.clone()
    }

    fn device_id(&self) -> String {
        self.creds.lock().expect("creds mutex").device_id.clone()
    }

    fn cookie(&self) -> Option<String> {
        self.creds.lock().expect("creds mutex").cookie.clone()
    }

    /// Mirrors `commonHeaders`. `user-agent` is deliberately absent — see
    /// `crate::http`'s module docs — the emulation profile supplies it.
    fn common_headers(&self, path: &str) -> Vec<(&'static str, String)> {
        let mut headers = vec![
            ("accept", "*/*".to_string()),
            ("accept-language", "en-US,en;q=0.9".to_string()),
            ("authorization", format!("Bearer {}", self.access_token())),
        ];
        if let Some(cookie) = self.cookie() {
            headers.push(("cookie", cookie));
        }
        headers.push(("content-type", "application/json".to_string()));
        headers.push(("oai-device-id", self.device_id()));
        headers.push(("oai-language", "en-US".to_string()));
        headers.push(("origin", ORIGIN.to_string()));
        headers.push(("referer", format!("{ORIGIN}/")));
        headers.push(("x-openai-target-path", format!("/backend-api{path}")));
        headers.push(("x-openai-target-route", format!("/backend-api{path}")));
        headers
    }

    async fn get_json(&self, path: &str) -> Result<Value, BackendApiError> {
        let mut request = self.http.get(format!("{BASE_URL}{path}"));
        for (name, value) in self.common_headers(path) {
            request = request.header(name, value);
        }
        let response = request
            .send()
            .await
            .map_err(|e| BackendApiError::new(format!("GET {path} failed to send: {e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| BackendApiError::new(format!("GET {path} failed to read body: {e}")))?;
        let parsed = safe_json(&text);
        if !status.is_success() {
            return Err(BackendApiError::with_body(
                format!("GET {path} failed: {}", status.as_u16()),
                status.as_u16(),
                parsed.unwrap_or(Value::String(text)),
            ));
        }
        match parsed {
            Some(v) if is_object(&v) => Ok(v),
            _ => Err(BackendApiError::new(format!("GET {path} returned non-object JSON"))),
        }
    }

    async fn post_json(
        &self,
        path: &str,
        body: &Value,
        extra_headers: &[(&str, String)],
    ) -> Result<Value, BackendApiError> {
        let mut request = self.http.post(format!("{BASE_URL}{path}"));
        for (name, value) in self.common_headers(path) {
            request = request.header(name, value);
        }
        for (name, value) in extra_headers {
            request = request.header(*name, value.as_str());
        }
        let response = request
            .json(body)
            .send()
            .await
            .map_err(|e| BackendApiError::new(format!("POST {path} failed to send: {e}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| BackendApiError::new(format!("POST {path} failed to read body: {e}")))?;
        let parsed = safe_json(&text);
        if !status.is_success() {
            return Err(BackendApiError::with_body(
                format!("POST {path} failed: {}", status.as_u16()),
                status.as_u16(),
                parsed.unwrap_or(Value::String(text)),
            ));
        }
        match parsed {
            Some(v) if is_object(&v) => Ok(v),
            _ => Err(BackendApiError::new(format!("POST {path} returned non-object JSON"))),
        }
    }

    pub async fn fetch_me(&self) -> Result<Value, BackendApiError> {
        let json = self.get_json("/me").await?;
        let account = json.get("account").filter(|v| is_object(v));
        if let Some(id) = account.and_then(|a| a.get("account_user_id")).and_then(Value::as_str) {
            *self.account_id.lock().expect("account_id mutex") = Some(id.to_string());
        } else if let Some(id) = json
            .get("orgs")
            .and_then(|o| o.get("data"))
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|first| first.get("id"))
            .and_then(Value::as_str)
        {
            *self.account_id.lock().expect("account_id mutex") = Some(id.to_string());
        }
        Ok(json)
    }

    pub async fn fetch_models(&self) -> Result<Value, BackendApiError> {
        self.get_json("/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true")
            .await
    }

    pub async fn fetch_gpt_models(&self) -> Result<Value, BackendApiError> {
        self.get_json("/models/gpts").await
    }

    pub async fn fetch_gizmo_sidebar(
        &self,
        limit: Option<u32>,
        owned_only: Option<bool>,
        conversations_per_gizmo: Option<u32>,
    ) -> Result<Value, BackendApiError> {
        let path = format!(
            "/gizmos/snorlax/sidebar?owned_only={}&conversations_per_gizmo={}&limit={}",
            owned_only.unwrap_or(true),
            conversations_per_gizmo.unwrap_or(5),
            limit.unwrap_or(50),
        );
        self.get_json(&path).await
    }

    /// Actual Custom GPTs (owned + pinned in the sidebar), as opposed to
    /// `/gizmos/snorlax/sidebar` above which — despite the shared "gizmos/"
    /// path prefix — only surfaces ChatGPT Projects ("snorlax"), never GPTs.
    /// Upstream caps `limit` at 20 and exposes no pagination cursor.
    pub async fn fetch_gizmo_bootstrap(&self, limit: Option<u32>) -> Result<Value, BackendApiError> {
        let path = format!("/gizmos/bootstrap?limit={}", limit.unwrap_or(20).min(20));
        self.get_json(&path).await
    }

    pub async fn fetch_gizmo(&self, id_or_slug: &str) -> Result<Value, BackendApiError> {
        self.get_json(&format!(
            "/gizmos/{}",
            url::form_urlencoded::byte_serialize(id_or_slug.as_bytes()).collect::<String>()
        ))
        .await
    }

    pub async fn fetch_conversations(
        &self,
        offset: Option<u32>,
        limit: Option<u32>,
        archived: Option<bool>,
    ) -> Result<(Vec<RemoteConversationSummary>, u64), BackendApiError> {
        let path = format!(
            "/conversations?offset={}&limit={}&order=updated&is_archived={}",
            offset.unwrap_or(0),
            limit.unwrap_or(100),
            archived.unwrap_or(false),
        );
        let raw = self.get_json(&path).await?;
        let items = raw.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let now = iso_now();
        let mapped: Vec<RemoteConversationSummary> = items
            .iter()
            .filter_map(|item| map_conversation_summary(item, &now))
            .collect();
        let total = raw.get("total").and_then(Value::as_u64).unwrap_or(items.len() as u64);
        Ok((mapped, total))
    }

    pub async fn fetch_conversation(&self, id: &str) -> Result<Value, BackendApiError> {
        self.get_json(&format!(
            "/conversation/{}",
            url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
        ))
        .await
    }

    pub async fn init_conversation(
        &self,
        timezone: &str,
        timezone_offset_min: i32,
        gizmo_id: Option<&str>,
        requested_model: Option<&str>,
        conversation_id: Option<&str>,
        history_and_training_disabled: bool,
    ) -> Result<ConversationInitResult, BackendApiError> {
        let mut body = json!({
            "requested_default_model": requested_model,
            "conversation_id": conversation_id,
            "timezone": timezone,
            "timezone_offset_min": timezone_offset_min,
            "conversation_origin": Value::Null,
        });
        if let Some(gizmo_id) = gizmo_id {
            body["gizmo_id"] = json!(gizmo_id);
        }
        if history_and_training_disabled {
            body["history_and_training_disabled"] = json!(true);
        }

        let raw = self.post_json("/conversation/init", &body, &[]).await?;

        let limits_progress = raw
            .get("limits_progress")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let blocked_features = raw
            .get("blocked_features")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        Ok(ConversationInitResult {
            default_model_slug: raw.get("default_model_slug").and_then(Value::as_str).map(str::to_string),
            intended_default_model_slug: raw
                .get("intended_default_model_slug")
                .and_then(Value::as_str)
                .map(str::to_string),
            limits_progress,
            blocked_features,
            raw,
        })
    }

    /// Current follow-up flow: context-change prepare -> conduit A ->
    /// composer-state prepare -> conduit B.
    ///
    /// `conduit_token` is not documented as strictly required by
    /// `f/conversation`, but the real chatgpt.com web client fires this
    /// debounced prepare on every keystroke/context-change for EVERY turn —
    /// including a brand-new conversation's first message, where
    /// `conversation_id` is still null. So this is called unconditionally by
    /// `send_message` on every follow-up turn, and its result is threaded
    /// into `f/conversation` whenever present rather than only on turns
    /// where the upstream response happens to demand it — better to send a
    /// token it doesn't strictly need than to omit one it does.
    #[allow(clippy::too_many_arguments)]
    async fn prepare_followup(
        &self,
        model: &str,
        conversation_id: &str,
        parent_message_id: &str,
        prompt: &str,
        timezone: &str,
        timezone_offset_min: i32,
        gizmo_id: Option<&str>,
    ) -> Result<Option<String>, BackendApiError> {
        let mut common = json!({
            "action": "next",
            "conversation_id": conversation_id,
            "parent_message_id": parent_message_id,
            "model": model,
            "timezone_offset_min": timezone_offset_min,
            "timezone": timezone,
            "conversation_mode": mode_for(gizmo_id, None),
        });
        merge_object(&mut common, common_context());

        let mut first_body = common.clone();
        merge_object(
            &mut first_body,
            json!({
                "client_prepare_state": "none",
                "client_prepare_dispatch": "immediate",
                "client_prepare_source": "context_change",
            }),
        );
        let first = match self.post_json("/f/conversation/prepare", &first_body, &[]).await {
            Ok(v) => v,
            Err(e) if e.status.is_some_and(|s| TOLERATED_PREPARE_STATUSES.contains(&s)) => {
                return Ok(None);
            }
            Err(e) => return Err(e),
        };
        let conduit_a = first.get("conduit_token").and_then(Value::as_str).map(str::to_string);

        let user_preview_id = Uuid::new_v4().to_string();
        let mut second_body = common;
        merge_object(
            &mut second_body,
            json!({
                "client_prepare_state": "success",
                "client_prepare_dispatch": "debounced",
                "client_prepare_source": "composer_editor_state",
                "partial_query": {
                    "id": user_preview_id,
                    "author": {"role": "user"},
                    "content": {"content_type": "text", "parts": [prompt.chars().next().map(String::from).unwrap_or_default()]},
                },
            }),
        );
        let extra: Vec<(&str, String)> = conduit_a
            .as_ref()
            .map(|t| vec![("x-conduit-token", t.clone())])
            .unwrap_or_default();

        match self.post_json("/f/conversation/prepare", &second_body, &extra).await {
            Ok(second) => Ok(second
                .get("conduit_token")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or(conduit_a)),
            Err(e) if e.status.is_some_and(|s| TOLERATED_PREPARE_STATUSES.contains(&s)) => Ok(conduit_a),
            Err(e) => Err(e),
        }
    }

    /// Runs the proof-of-work + Turnstile handshake and returns the
    /// resulting sentinel headers for `/f/conversation`.
    ///
    /// `turnstile_override` takes precedence; otherwise a Turnstile token
    /// cached on the credentials is consumed exactly once (cleared
    /// immediately once read, whether or not it turns out to be required),
    /// matching upstream's `this.creds.turnstileToken = null` before
    /// resolution runs.
    async fn sentinel_handshake(
        &self,
        turnstile_override: Option<&str>,
    ) -> Result<SentinelHandshake, BackendApiError> {
        let prepare_res = self
            .post_json("/sentinel/chat-requirements/prepare", &json!({"p": ""}), &[])
            .await?;

        let pow = prepare_res.get("proofofwork").filter(|v| is_object(v));
        let proof_dx = pow.and_then(|p| p.get("dx")).and_then(Value::as_str);
        let proof_config = proof::decode_proof_config(proof_dx).map(ProofConfig::from_values);
        let pow_required = pow.and_then(|p| p.get("required")).and_then(Value::as_bool).unwrap_or(false);
        // Owned copies: `GenerateProofOptions` borrows its seed/difficulty,
        // and spawn_blocking's closure needs `'static` data to move in.
        let seed = pow.and_then(|p| p.get("seed")).and_then(Value::as_str).unwrap_or("").to_string();
        let difficulty = pow.and_then(|p| p.get("difficulty")).and_then(Value::as_str).unwrap_or("").to_string();

        let turnstile = prepare_res.get("turnstile").filter(|v| is_object(v));
        let turnstile_required = turnstile.and_then(|t| t.get("required")).and_then(Value::as_bool).unwrap_or(false);

        // CPU-bound: run off the caller's async task.
        let proof_token = tokio::task::spawn_blocking(move || {
            let mut proof_opts = GenerateProofOptions::new(pow_required, &seed, &difficulty);
            proof_opts.proof_config = proof_config;
            proof::generate_proof_token(proof_opts)
        })
        .await
        .map_err(|e| BackendApiError::new(format!("proof-of-work task panicked: {e}")))?
        .map_err(|e| BackendApiError::new(e.to_string()))?;

        // `resolveTurnstileToken` short-circuits to null whenever `!required`
        // — even a supplied override is discarded in that case, not just
        // the cached credential token. Verified directly against
        // turnstile.ts in Node: `resolveTurnstileToken({required: false,
        // overrideToken: "x"})` returns null, not "x". Both sources are
        // therefore gated on `turnstile_required` here, not only the
        // credential one.
        //
        // Currently resolved only via an explicit override or the cached
        // credential token when required; the headless-browser solver is a
        // separate, not-yet-ported piece (see the migration plan's
        // Turnstile decision).
        let turnstile_token = if turnstile_required {
            let credential_turnstile = self.creds.lock().expect("creds mutex").turnstile_token.take();
            turnstile_override.map(str::to_string).or(credential_turnstile).unwrap_or_default()
        } else {
            String::new()
        };
        if turnstile_required && turnstile_token.is_empty() {
            return Err(BackendApiError::new(
                "Turnstile challenge required but no token was available (headless solving not yet ported)",
            ));
        }

        let finalize_res = self
            .post_json(
                "/sentinel/chat-requirements/finalize",
                &json!({
                    "prepare_token": prepare_res.get("prepare_token"),
                    "proofofwork": proof_token,
                    // Send the resolved Turnstile token if available;
                    // otherwise fall back to null so unconstrained sessions
                    // succeed without a browser widget.
                    "turnstile": if turnstile_token.is_empty() { Value::Null } else { json!(turnstile_token) },
                }),
                &[],
            )
            .await?;

        let token = finalize_res
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| BackendApiError::new("Sentinel finalize succeeded but returned no requirements token"))?
            .to_string();

        Ok(SentinelHandshake {
            chat_requirements_token: token,
            proof_token,
            turnstile_token,
        })
    }

    pub async fn upload_file(
        &self,
        data: &[u8],
        file_name: &str,
        mime_type: &str,
        width: Option<u32>,
        height: Option<u32>,
    ) -> Result<UploadedFile, BackendApiError> {
        let use_case = if mime_type.starts_with("image/") {
            UseCase::Multimodal
        } else {
            UseCase::MyFiles
        };
        let use_case_str = match use_case {
            UseCase::Multimodal => "multimodal",
            UseCase::MyFiles => "my_files",
        };

        let created = self
            .post_json(
                "/files",
                &json!({"file_name": file_name, "file_size": data.len(), "use_case": use_case_str}),
                &[],
            )
            .await?;

        let upload_url = created
            .get("upload_url")
            .and_then(Value::as_str)
            .ok_or_else(|| BackendApiError::new("File create response did not contain upload_url and file_id"))?
            .to_string();
        let file_id = created
            .get("file_id")
            .and_then(Value::as_str)
            .ok_or_else(|| BackendApiError::new("File create response did not contain upload_url and file_id"))?
            .to_string();

        let upload = self
            .http
            .put(&upload_url)
            .header("content-type", mime_type)
            .header("origin", ORIGIN)
            .header("x-ms-blob-type", "BlockBlob")
            .header("x-ms-version", "2020-04-08")
            .body(data.to_vec())
            .send()
            .await
            .map_err(|e| BackendApiError::new(format!("File blob upload failed to send: {e}")))?;
        if !upload.status().is_success() {
            return Err(BackendApiError::with_status(
                format!("File blob upload failed: {}", upload.status().as_u16()),
                upload.status().as_u16(),
            ));
        }

        let marked = self
            .post_json(
                &format!(
                    "/files/{}/uploaded",
                    url::form_urlencoded::byte_serialize(file_id.as_bytes()).collect::<String>()
                ),
                &json!({}),
                &[],
            )
            .await?;

        let mut raw = created.as_object().cloned().unwrap_or_default();
        if let Some(marked_obj) = marked.as_object() {
            for (k, v) in marked_obj {
                raw.insert(k.clone(), v.clone());
            }
        }

        Ok(UploadedFile {
            file_id,
            file_name: file_name.to_string(),
            file_size: data.len() as u64,
            mime_type: mime_type.to_string(),
            use_case,
            width,
            height,
            raw: Value::Object(raw),
        })
    }

    pub async fn resolve_asset_download(
        &self,
        asset_pointer: &str,
        conversation_id: Option<&str>,
    ) -> Result<String, BackendApiError> {
        Ok(self.resolve_asset_download_metadata(asset_pointer, conversation_id).await?.url)
    }

    pub async fn resolve_asset_download_metadata(
        &self,
        asset_pointer: &str,
        conversation_id: Option<&str>,
    ) -> Result<AssetDownload, BackendApiError> {
        let path = if let Some(id) = asset_pointer.strip_prefix("file-service://") {
            format!(
                "/files/{}/download",
                url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
            )
        } else if let Some(rest) = asset_pointer.strip_prefix("sediment://") {
            let id = rest
                .split('#')
                .find(|part| part.starts_with("file-") || part.starts_with("file_"))
                .unwrap_or(rest);
            let Some(conversation_id) = conversation_id else {
                return Err(BackendApiError::new("sediment asset download requires conversationId"));
            };
            format!(
                "/files/download/{}?conversation_id={}&inline=false",
                url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>(),
                url::form_urlencoded::byte_serialize(conversation_id.as_bytes()).collect::<String>(),
            )
        } else {
            return Err(BackendApiError::new("Unsupported asset pointer"));
        };

        let json = self.get_json(&path).await?;
        asset_download(&json)
    }

    pub async fn resolve_sandbox_download(
        &self,
        sandbox_path: &str,
        conversation_id: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<String, BackendApiError> {
        Ok(self
            .resolve_sandbox_download_metadata(sandbox_path, conversation_id, message_id)
            .await?
            .url)
    }

    pub async fn resolve_sandbox_download_metadata(
        &self,
        sandbox_path: &str,
        conversation_id: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<AssetDownload, BackendApiError> {
        let (Some(conversation_id), Some(message_id)) = (conversation_id, message_id) else {
            return Err(BackendApiError::new(
                "Sandbox download requires conversation, message and absolute path",
            ));
        };
        if !sandbox_path.starts_with('/') {
            return Err(BackendApiError::new(
                "Sandbox download requires conversation, message and absolute path",
            ));
        }
        let path = format!(
            "/conversation/{}/interpreter/download?message_id={}&sandbox_path={}",
            url::form_urlencoded::byte_serialize(conversation_id.as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(message_id.as_bytes()).collect::<String>(),
            url::form_urlencoded::byte_serialize(sandbox_path.as_bytes()).collect::<String>(),
        );
        let json = self.get_json(&path).await?;
        asset_download(&json)
    }

    /// Estuary URLs need upstream authentication even when they contain a
    /// signature. Never forward that authentication to a CDN or an
    /// arbitrary redirect target — see [`classify_asset_hop`].
    pub async fn fetch_asset_content(&self, download_url: &str) -> Result<wreq::Response, BackendApiError> {
        let mut url = url::Url::parse(download_url)
            .map_err(|_| BackendApiError::new("Unsupported asset download destination"))?;

        for _ in 0..=3 {
            let classification = classify_asset_hop(&url);
            if !classification.is_allowed {
                return Err(BackendApiError::new("Unsupported asset download destination"));
            }

            let mut request = self.http.get(url.as_str()).header("accept", "*/*");
            if classification.is_estuary {
                let path_for_headers = url.path().strip_prefix("/backend-api").unwrap_or(url.path());
                for (name, value) in self.common_headers(path_for_headers) {
                    request = request.header(name, value);
                }
                request = request.header("accept", "*/*");
            }
            let response = request
                .send()
                .await
                .map_err(|e| BackendApiError::new(format!("asset fetch failed to send: {e}")))?;

            if !matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
                return Ok(response);
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
                .ok_or_else(|| BackendApiError::new("Asset redirect has no destination"))?;
            url = url
                .join(&location)
                .map_err(|_| BackendApiError::new("Asset redirect has no destination"))?;
        }
        Err(BackendApiError::new("Too many asset redirects"))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_message(&self, opts: SendMessageOptions<'_>) -> Result<SendMessageResult, BackendApiError> {
        let timezone = opts.timezone.unwrap_or("UTC");
        let timezone_offset_min = opts.timezone_offset_min.unwrap_or(0);
        // Work Mode itself is an asynchronous task protocol, not
        // conversation SSE. Reject unsupported aliases; never silently
        // substitute another model.
        if opts.model.ends_with("-wm") {
            return Err(BackendApiError::with_status(
                "Work Mode is not supported by this transport",
                400,
            ));
        }
        let first_turn = opts.conversation_id.is_none();
        let parent_message_id = opts.parent_message_id.unwrap_or("client-created-root");

        let conduit_token = if !first_turn {
            let conversation_id = opts.conversation_id.expect("checked !first_turn");
            self.prepare_followup(
                opts.model,
                conversation_id,
                parent_message_id,
                opts.prompt,
                timezone,
                timezone_offset_min,
                opts.gizmo_id,
            )
            .await?
        } else {
            None
        };

        let sentinel = self.sentinel_handshake(opts.turnstile_token).await?;
        let user_message_id = Uuid::new_v4().to_string();
        let turn_trace_id = Uuid::new_v4().to_string();
        let create_time_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();

        let mut body = json!({
            "action": "next",
            "messages": [build_user_message(opts.prompt, opts.attachments, &user_message_id, create_time_secs)],
            "parent_message_id": parent_message_id,
            "model": opts.model,
            "client_prepare_state": if first_turn { "none" } else { "success" },
            "timezone_offset_min": timezone_offset_min,
            "timezone": timezone,
            "conversation_mode": mode_for(opts.gizmo_id, if first_turn { opts.gizmo_payload } else { None }),
            "enable_message_followups": true,
            "paragen_cot_summary_display_override": "allow",
            "force_parallel_switch": "auto",
        });
        if let Some(cid) = opts.conversation_id {
            body["conversation_id"] = json!(cid);
        }
        if opts.history_and_training_disabled {
            body["history_and_training_disabled"] = json!(true);
        }
        merge_object(&mut body, common_context());

        let mut headers = self.common_headers("/f/conversation");
        if let Some(account_id) = self.account_id.lock().expect("account_id mutex").clone() {
            headers.push(("chatgpt-account-id", account_id));
        }
        headers.push((
            "openai-sentinel-chat-requirements-token",
            sentinel.chat_requirements_token.clone(),
        ));
        if let Some(proof) = &sentinel.proof_token {
            headers.push(("openai-sentinel-proof-token", proof.clone()));
        }
        headers.push(("x-oai-turn-trace-id", turn_trace_id));
        if let Some(conduit) = &conduit_token {
            headers.push(("x-conduit-token", conduit.clone()));
        }
        headers.push(("accept", "text/event-stream".to_string()));

        let mut request = self.http.post(format!("{BASE_URL}/f/conversation"));
        for (name, value) in &headers {
            request = request.header(*name, value.as_str());
        }
        let response = request
            .json(&body)
            .send()
            .await
            .map_err(|e| BackendApiError::new(format!("POST /f/conversation failed to send: {e}")))?;

        if !response.status().is_success() {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            return Err(BackendApiError::with_body(
                format!("POST /f/conversation failed: {status}"),
                status,
                Value::String(text),
            ));
        }

        let suppress = first_turn && opts.gizmo_id.is_some();
        let mut reducer = ConversationStreamReducer::new(ReducerOptions {
            suppress_first_turn_tool_narration: suppress,
        });
        let mut all_events: Vec<NormalizedConversationEvent> = Vec::new();
        let mut frames = SseFrameDecoder::new();

        let deliver = |reducer: &mut ConversationStreamReducer, all_events: &mut Vec<NormalizedConversationEvent>| {
            for event in reducer.drain_events() {
                all_events.push(event.clone());
                if let Some(on_event) = opts.on_event {
                    on_event(&event);
                }
                if let NormalizedConversationEvent::AssistantText { delta, text, .. } = &event
                    && !delta.is_empty()
                    && let Some(on_delta) = opts.on_delta
                {
                    on_delta(delta, text);
                }
            }
        };

        use futures_util::StreamExt as _;
        let mut byte_stream = response.bytes_stream();
        loop {
            let chunk = match byte_stream.next().await {
                Some(Ok(bytes)) => bytes,
                Some(Err(e)) => return Err(BackendApiError::new(format!("stream read failed: {e}"))),
                None => break,
            };
            let text = String::from_utf8_lossy(&chunk);
            for frame in frames.push(&text) {
                for payload in iter_sse_data_lines(&frame) {
                    reducer.feed(payload);
                    deliver(&mut reducer, &mut all_events);
                    if reducer.is_done() {
                        break;
                    }
                }
                if reducer.is_done() {
                    break;
                }
            }
            if reducer.is_done() {
                break;
            }
        }
        for frame in frames.finish() {
            for payload in iter_sse_data_lines(&frame) {
                reducer.feed(payload);
                deliver(&mut reducer, &mut all_events);
            }
        }
        deliver(&mut reducer, &mut all_events);

        if !reducer.is_done() {
            return Err(BackendApiError::new("Conversation stream interrupted before completion"));
        }
        if reducer.error().is_none() && reducer.current_assistant_message_id().is_none() {
            return Err(BackendApiError::new(
                "Unsupported conversation response: no assistant node was received",
            ));
        }
        if let Some(error_code) = reducer.error() {
            return Err(BackendApiError::new(format!(
                "Conversation stream returned error_code={error_code}"
            )));
        }

        Ok(SendMessageResult {
            text: reducer.text().to_string(),
            conversation_id: reducer.conversation_id_value().map(str::to_string),
            message_id: reducer.current_assistant_message_id().map(str::to_string),
            user_message_id,
            status: reducer.status().map(str::to_string),
            events: all_events,
        })
    }
}

struct SentinelHandshake {
    chat_requirements_token: String,
    proof_token: Option<String>,
    /// Computed for parity with upstream's returned shape, but — as in the
    /// original `sendMessage`, which reads only `chatRequirementsToken` and
    /// `proofToken` off this result — nothing currently reads it back out.
    #[allow(dead_code)]
    turnstile_token: String,
}

pub struct SendMessageOptions<'a> {
    pub prompt: &'a str,
    pub model: &'a str,
    pub conversation_id: Option<&'a str>,
    pub parent_message_id: Option<&'a str>,
    pub timezone: Option<&'a str>,
    pub timezone_offset_min: Option<i32>,
    pub gizmo_id: Option<&'a str>,
    /// Full current `/gizmos/<id>` response; sent only on the first gizmo turn.
    pub gizmo_payload: Option<&'a Value>,
    pub attachments: &'a [UploadedFile],
    /// Temporary/incognito chat: excluded from chatgpt.com history and model training.
    pub history_and_training_disabled: bool,
    /// Optional Cloudflare Turnstile token override for sentinel requirements.
    pub turnstile_token: Option<&'a str>,
    pub on_delta: Option<&'a dyn Fn(&str, &str)>,
    pub on_event: Option<&'a dyn Fn(&NormalizedConversationEvent)>,
}

/// A stateful convenience wrapper. Server-side persistence can serialize
/// `state` between requests instead of depending on an in-memory object.
pub struct ChatGptConversationSession<'a> {
    client: &'a ChatGptBackendClient,
    pub state: ConversationSessionState,
    gizmo_payload: Option<Value>,
}

impl<'a> ChatGptConversationSession<'a> {
    pub fn new(client: &'a ChatGptBackendClient, state: ConversationSessionState, gizmo_payload: Option<Value>) -> Self {
        Self { client, state, gizmo_payload }
    }

    pub async fn initialize(
        &mut self,
        timezone: &str,
        timezone_offset_min: i32,
    ) -> Result<ConversationInitResult, BackendApiError> {
        let requested_model = (self.state.model != "auto").then_some(self.state.model.as_str());
        let init = self
            .client
            .init_conversation(
                timezone,
                timezone_offset_min,
                self.state.gizmo_id.as_deref(),
                requested_model,
                self.state.conversation_id.as_deref(),
                false,
            )
            .await?;
        let selected_model = init.default_model_slug.clone().or_else(|| init.intended_default_model_slug.clone());
        if self.state.model == "auto"
            && let Some(model) = selected_model
        {
            self.state.model = model;
        }
        self.state.initialized = true;
        Ok(init)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        &mut self,
        prompt: &str,
        timezone: Option<&str>,
        timezone_offset_min: Option<i32>,
        attachments: &[UploadedFile],
        history_and_training_disabled: bool,
        turnstile_token: Option<&str>,
        on_delta: Option<&dyn Fn(&str, &str)>,
        on_event: Option<&dyn Fn(&NormalizedConversationEvent)>,
    ) -> Result<SendMessageResult, BackendApiError> {
        if !self.state.initialized {
            self.initialize(timezone.unwrap_or("UTC"), timezone_offset_min.unwrap_or(0)).await?;
        }

        let gizmo_payload = self.gizmo_payload.clone();
        let result = self
            .client
            .send_message(SendMessageOptions {
                prompt,
                model: &self.state.model,
                conversation_id: self.state.conversation_id.as_deref(),
                parent_message_id: Some(self.state.current_node_id.as_str()),
                timezone,
                timezone_offset_min,
                gizmo_id: self.state.gizmo_id.as_deref(),
                gizmo_payload: gizmo_payload.as_ref(),
                attachments,
                history_and_training_disabled,
                turnstile_token,
                on_delta,
                on_event,
            })
            .await?;

        if let Some(cid) = &result.conversation_id {
            self.state.conversation_id = Some(cid.clone());
        }
        if let Some(mid) = &result.message_id {
            self.state.current_node_id = mid.clone();
        }
        // Full gizmo bootstrap belongs on the first turn only.
        self.gizmo_payload = None;
        Ok(result)
    }
}

/// Shallow-merges `patch`'s keys into `target`, both assumed to be objects.
/// Stands in for JS's `{...a, ...b}` object-spread merge used throughout the
/// request-body construction above.
fn merge_object(target: &mut Value, patch: Value) {
    if let (Value::Object(target), Value::Object(patch)) = (target, patch) {
        for (key, value) in patch {
            target.insert(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::UseCase;

    #[test]
    fn mode_for_matches_the_original_output_exactly() {
        assert_eq!(mode_for(None, None), json!({"kind": "primary_assistant"}));
        assert_eq!(
            mode_for(Some("g-123"), None),
            json!({"kind": "gizmo_interaction", "gizmo_id": "g-123"})
        );
        assert_eq!(
            mode_for(Some("g-123"), Some(&json!({"name": "MyGPT"}))),
            json!({"kind": "gizmo_interaction", "gizmo_id": "g-123", "gizmo": {"name": "MyGPT"}})
        );
        // An empty string is falsy in JS (`if (!gizmoId)`), so it takes the
        // primary_assistant branch too.
        assert_eq!(mode_for(Some(""), None), json!({"kind": "primary_assistant"}));
    }

    #[test]
    fn common_context_matches_the_original_output_exactly() {
        // Captured verbatim from the real commonContext() in Node.
        let expected: Value = serde_json::from_str(r#"{"system_hints":[],"model_response_contracts":[{"id":"photo_upload_action.v1","protocol_version":1,"presets":["cap:image","cap:file","placement:end"]}],"supports_buffering":true,"supported_encodings":["v1"],"client_contextual_info":{"app_name":"chatgpt.com","has_web_push_capabilities":false,"web_push_notification_permission":"default"},"local_function_names":["local.continue_in_work"]}"#).unwrap();
        assert_eq!(common_context(), expected);
    }

    fn file(id: &str, size: u64, mime: &str, name: &str, w: Option<u32>, h: Option<u32>) -> UploadedFile {
        UploadedFile {
            file_id: id.to_string(),
            file_name: name.to_string(),
            file_size: size,
            mime_type: mime.to_string(),
            use_case: UseCase::Multimodal,
            width: w,
            height: h,
            raw: Value::Null,
        }
    }

    #[test]
    fn build_user_message_without_attachments_matches_the_original() {
        let expected: Value = serde_json::from_str(
            r#"{"id":"u1","author":{"role":"user"},"create_time":1234.0,"content":{"content_type":"text","parts":["hi"]},"metadata":{}}"#,
        )
        .unwrap();
        assert_eq!(build_user_message("hi", &[], "u1", 1234.0), expected);
    }

    #[test]
    fn build_user_message_with_an_image_attachment_matches_the_original() {
        let expected: Value = serde_json::from_str(
            r#"{"id":"u1","author":{"role":"user"},"create_time":1234.0,"content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"file-service://f1","size_bytes":100,"width":10,"height":20},"hi"]},"metadata":{"serialization_metadata":{"custom_symbol_offsets":[]},"attachments":[{"id":"f1","mimeType":"image/png","name":"a.png","size":100,"width":10,"height":20}]}}"#,
        )
        .unwrap();
        let attachments = [file("f1", 100, "image/png", "a.png", Some(10), Some(20))];
        assert_eq!(build_user_message("hi", &attachments, "u1", 1234.0), expected);
    }

    #[test]
    fn build_user_message_omits_width_and_height_when_absent() {
        let expected: Value = serde_json::from_str(
            r#"{"id":"u1","author":{"role":"user"},"create_time":1234.0,"content":{"content_type":"multimodal_text","parts":[{"asset_pointer":"file-service://f1","size_bytes":100},"hi"]},"metadata":{"serialization_metadata":{"custom_symbol_offsets":[]},"attachments":[{"id":"f1","mimeType":"text/plain","name":"a.txt","size":100}]}}"#,
        )
        .unwrap();
        let attachments = [file("f1", 100, "text/plain", "a.txt", None, None)];
        assert_eq!(build_user_message("hi", &attachments, "u1", 1234.0), expected);
    }

    fn hop(url: &str) -> AssetHopClassification {
        classify_asset_hop(&url::Url::parse(url).unwrap())
    }

    #[test]
    fn asset_hop_classification_matches_the_original_on_every_checked_url() {
        // Verified against the real fetchAssetContent guard logic in Node.
        assert_eq!(
            hop("https://chatgpt.com/backend-api/estuary/content?x=1"),
            AssetHopClassification { is_estuary: true, is_cdn: false, is_allowed: true }
        );
        assert_eq!(
            hop("https://files.oaiusercontent.com/abc"),
            AssetHopClassification { is_estuary: false, is_cdn: true, is_allowed: true }
        );
        assert_eq!(
            hop("https://oaiusercontent.com/abc"),
            AssetHopClassification { is_estuary: false, is_cdn: true, is_allowed: true }
        );
        assert_eq!(
            hop("https://x.blob.core.windows.net/abc"),
            AssetHopClassification { is_estuary: false, is_cdn: true, is_allowed: true }
        );
        assert!(!hop("https://evil.com/abc").is_allowed);
        assert!(!hop("http://chatgpt.com/backend-api/estuary/content").is_allowed);
        assert!(!hop("https://chatgpt.com:8443/backend-api/estuary/content").is_allowed);
        assert!(!hop("https://user:pass@files.oaiusercontent.com/abc").is_allowed);
        assert!(!hop("https://notoaiusercontent.com/abc").is_allowed);
        assert!(!hop("https://chatgpt.com/backend-api/other/path").is_allowed);
        // A CDN host is still rejected with a non-standard port.
        assert!(!hop("https://files.oaiusercontent.com:9999/abc").is_allowed);
        // Domain-suffix confusion: this is NOT a subdomain of
        // oaiusercontent.com, `.ends_with(".oaiusercontent.com")` correctly
        // requires the dot.
        assert!(!hop("https://oaiusercontent.com.evil.com/abc").is_allowed);
    }

    #[test]
    fn asset_download_requires_a_download_url() {
        let ok = asset_download(&json!({"download_url": "https://x", "file_name": "a.png", "mime_type": "image/png"})).unwrap();
        assert_eq!(ok.url, "https://x");
        assert_eq!(ok.file_name.as_deref(), Some("a.png"));
        assert_eq!(ok.mime_type.as_deref(), Some("image/png"));

        let minimal = asset_download(&json!({"download_url": "https://x"})).unwrap();
        assert_eq!(minimal.file_name, None);

        assert!(asset_download(&json!({})).is_err());
    }

    #[test]
    fn conversation_summary_mapping_matches_the_original() {
        let now = "2026-01-01T00:00:00.000Z";
        let mapped = map_conversation_summary(
            &json!({"id": "c1", "title": "Hi", "create_time": "2025-01-01", "update_time": "2025-01-02", "current_node": "n1", "gizmo_id": "g1", "is_archived": true}),
            now,
        )
        .unwrap();
        assert_eq!(mapped.title, "Hi");
        assert_eq!(mapped.create_time, "2025-01-01");
        assert_eq!(mapped.update_time, "2025-01-02");
        assert!(mapped.is_archived);

        // No id at all -> filtered out (flatMap([]) in the original).
        assert!(map_conversation_summary(&json!({"title": "no id"}), now).is_none());

        // Missing title/timestamps fall back to defaults.
        let defaulted = map_conversation_summary(&json!({"id": "c2"}), now).unwrap();
        assert_eq!(defaulted.title, "New chat");
        assert_eq!(defaulted.create_time, now);
        assert_eq!(defaulted.update_time, now);
        assert!(!defaulted.is_archived);

        // update_time falls back to create_time when only create_time is present.
        let partial = map_conversation_summary(&json!({"id": "c3", "create_time": "2025-06-01"}), now).unwrap();
        assert_eq!(partial.update_time, "2025-06-01");
    }
}
