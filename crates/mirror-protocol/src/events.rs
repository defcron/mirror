//! Normalized conversation events — port of the `NormalizedConversationEvent`
//! union in `packages/protocol/src/types.ts`.
//!
//! Serialized with the same field names the TS version uses, since these are
//! persisted verbatim into `messages.events_json` and returned to API
//! callers.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NormalizedConversationEvent {
    AssistantText {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        delta: Option<String>,
    },
    Message {
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        raw: Value,
    },
    Tool {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        raw: Value,
    },
    Narration {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        raw: Value,
    },
    Citation {
        #[serde(rename = "fileId", skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
    },
    Image {
        #[serde(rename = "assetPointer")]
        asset_pointer: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
    },
    File {
        #[serde(rename = "assetPointer")]
        asset_pointer: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
    },
    Marker {
        #[serde(skip_serializing_if = "Option::is_none")]
        event: Option<String>,
        raw: Value,
    },
    CitationPatch {
        raw: Value,
    },
    Status {
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        raw: Value,
    },
    Raw {
        raw: Value,
    },
}
