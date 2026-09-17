//! Request and response schemas for Mirror's native `/api/*` and `/v1/*` routes.
//! Port of `apps/server/src/api-schemas.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetSessionBody {
    #[serde(rename = "sessionToken")]
    pub session_token: String,
    #[serde(rename = "turnstileToken", skip_serializing_if = "Option::is_none")]
    pub turnstile_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationIdParam {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelUpdateBody {
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchBody {
    #[serde(rename = "messageId")]
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn default_auto_model() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewConversationBody {
    #[serde(default = "default_auto_model")]
    pub model: String,
    #[serde(rename = "gizmoId", skip_serializing_if = "Option::is_none")]
    pub gizmo_id: Option<String>,
}

fn default_limit() -> usize {
    50
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationsQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_true")]
    pub sync: bool,
    #[serde(default)]
    pub resync: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetsQuery {
    pub pointer: String,
    #[serde(rename = "upstreamConversationId", skip_serializing_if = "Option::is_none")]
    pub upstream_conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatAttachment {
    #[serde(rename = "fileId")]
    pub file_id: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    #[serde(rename = "fileSize")]
    pub file_size: u64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "useCase")]
    pub use_case: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(default)]
    pub raw: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatBody {
    pub prompt: String,
    #[serde(default = "default_auto_model")]
    pub model: String,
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(rename = "gizmoId", skip_serializing_if = "Option::is_none")]
    pub gizmo_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(rename = "timezoneOffsetMin", skip_serializing_if = "Option::is_none")]
    pub timezone_offset_min: Option<i32>,
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
    #[serde(rename = "turnstileToken", skip_serializing_if = "Option::is_none")]
    pub turnstile_token: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_body_deserializes_with_defaults() {
        let raw = json!({ "prompt": "hello world" });
        let body: ChatBody = serde_json::from_value(raw).unwrap();
        assert_eq!(body.prompt, "hello world");
        assert_eq!(body.model, "auto");
        assert!(body.attachments.is_empty());
        assert_eq!(body.conversation_id, None);
    }

    #[test]
    fn set_session_body_round_trips() {
        let raw = json!({
            "sessionToken": "test-session-token-12345",
            "turnstileToken": "cf-token"
        });
        let body: SetSessionBody = serde_json::from_value(raw).unwrap();
        assert_eq!(body.session_token, "test-session-token-12345");
        assert_eq!(body.turnstile_token.as_deref(), Some("cf-token"));
    }

    #[test]
    fn conversation_param_and_model_update_round_trip() {
        let id_raw = json!({ "id": "conv-123" });
        let id_param: ConversationIdParam = serde_json::from_value(id_raw).unwrap();
        assert_eq!(id_param.id, "conv-123");

        let model_raw = json!({ "model": "gpt-4o" });
        let model_body: ModelUpdateBody = serde_json::from_value(model_raw).unwrap();
        assert_eq!(model_body.model, "gpt-4o");
    }

    #[test]
    fn branch_and_new_conversation_schemas() {
        let branch_raw = json!({
            "messageId": "msg-123",
            "title": "Branch Title"
        });
        let branch: BranchBody = serde_json::from_value(branch_raw).unwrap();
        assert_eq!(branch.message_id, "msg-123");
        assert_eq!(branch.title.as_deref(), Some("Branch Title"));

        let new_conv_raw = json!({ "gizmoId": "g-abc" });
        let new_conv: NewConversationBody = serde_json::from_value(new_conv_raw).unwrap();
        assert_eq!(new_conv.model, "auto");
        assert_eq!(new_conv.gizmo_id.as_deref(), Some("g-abc"));
    }

    #[test]
    fn conversations_and_assets_query_schemas() {
        let query_raw = json!({
            "limit": 25,
            "offset": 50,
            "sync": false,
            "resync": true
        });
        let query: ConversationsQuery = serde_json::from_value(query_raw).unwrap();
        assert_eq!(query.limit, 25);
        assert_eq!(query.offset, 50);
        assert!(!query.sync);
        assert!(query.resync);

        let asset_raw = json!({
            "pointer": "file-service://file-1",
            "upstreamConversationId": "up-conv-2"
        });
        let asset: AssetsQuery = serde_json::from_value(asset_raw).unwrap();
        assert_eq!(asset.pointer, "file-service://file-1");
        assert_eq!(asset.upstream_conversation_id.as_deref(), Some("up-conv-2"));
    }

    #[test]
    fn chat_attachment_schema() {
        let attach_raw = json!({
            "fileId": "f-123",
            "fileName": "photo.png",
            "fileSize": 1024,
            "mimeType": "image/png",
            "useCase": "multimodal",
            "width": 100,
            "height": 200
        });
        let attach: ChatAttachment = serde_json::from_value(attach_raw).unwrap();
        assert_eq!(attach.file_id, "f-123");
        assert_eq!(attach.file_name, "photo.png");
        assert_eq!(attach.file_size, 1024);
        assert_eq!(attach.mime_type, "image/png");
        assert_eq!(attach.use_case, "multimodal");
        assert_eq!(attach.width, Some(100));
        assert_eq!(attach.height, Some(200));
    }
}
