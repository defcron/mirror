//! Wire-protocol type definitions — port of `packages/protocol/src/types.ts`
//! (excluding `NormalizedConversationEvent`, `StreamEvent` and `PatchEvent`,
//! which already live in [`crate::events`] and [`crate::sse`]).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Credentials for one backend-api session.
#[derive(Debug, Clone)]
pub struct SessionCredentials {
    /// Bearer token minted from the long-lived ChatGPT session token.
    pub access_token: String,
    /// Optional cookie string. The working flow currently succeeds bearer-only.
    pub cookie: Option<String>,
    /// Stable per-install/device UUID sent as `oai-device-id`.
    pub device_id: String,
    /// Optional Cloudflare Turnstile token for sentinel requirements.
    pub turnstile_token: Option<String>,
    /// Long-lived session token (cookie value) when available.
    pub session_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversationInitResult {
    pub default_model_slug: Option<String>,
    pub intended_default_model_slug: Option<String>,
    pub limits_progress: Vec<Value>,
    pub blocked_features: Vec<String>,
    pub raw: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UseCase {
    Multimodal,
    MyFiles,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UploadedFile {
    pub file_id: String,
    pub file_name: String,
    pub file_size: u64,
    pub mime_type: String,
    pub use_case: UseCase,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ConversationSessionState {
    pub conversation_id: Option<String>,
    /// The assistant node that must become `parent_message_id` on the next turn.
    pub current_node_id: String,
    pub model: String,
    pub gizmo_id: Option<String>,
    pub initialized: bool,
    /// Temporary/incognito chat: excluded from chatgpt.com history and model training.
    pub private: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteConversationSummary {
    pub id: String,
    pub title: String,
    pub create_time: String,
    pub update_time: String,
    pub current_node_id: Option<String>,
    pub gizmo_id: Option<String>,
    pub is_archived: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SendMessageResult {
    pub text: String,
    pub conversation_id: Option<String>,
    /// Final assistant node, not the outgoing user message UUID.
    pub message_id: Option<String>,
    pub user_message_id: String,
    pub status: Option<String>,
    pub events: Vec<crate::events::NormalizedConversationEvent>,
}

/// Mirrors `BackendApiError`.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{message}")]
pub struct BackendApiError {
    pub message: String,
    pub status: Option<u16>,
    pub body: Option<Value>,
}

impl BackendApiError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            body: None,
        }
    }

    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status: Some(status),
            body: None,
        }
    }

    pub fn with_body(message: impl Into<String>, status: u16, body: Value) -> Self {
        Self {
            message: message.into(),
            status: Some(status),
            body: Some(body),
        }
    }
}
