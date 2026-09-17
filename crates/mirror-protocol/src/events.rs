//! Normalized conversation events — port of the `NormalizedConversationEvent`
//! union in `packages/protocol/src/types.ts`.
//!
//! Serialized with the same field names the TS version uses (these are
//! persisted verbatim into `messages.events_json` and returned to API
//! callers). `#[serde(tag = "kind")]` (internally tagged) produces the same
//! flat JSON shape TS's discriminated union does:
//! `{"kind": "...", ...fields, "displayHidden"?: bool}`, not a nested
//! `{"kind": {...}}` wrapper.
//!
//! One deliberate divergence from the *declared* TS type, kept for byte-exact
//! JSON parity with actual runtime output: `scanSpecials` builds an `image`
//! event via `{ kind: "image", assetPointer, ...(title ? {title} : {}), raw }`
//! — the spread adds `title` at runtime whenever present, even though the
//! `image` variant's type declaration in `types.ts` does not include a
//! `title` field. Verified directly in Node: an image event with a `title`
//! source object serializes with `"title"` in the output. `Image` therefore
//! carries an optional `title` here despite the stricter upstream type.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NormalizedConversationEvent {
    AssistantText {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        delta: String,
        text: String,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Message {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        role: Option<String>,
        #[serde(rename = "contentType")]
        content_type: Option<String>,
        #[serde(rename = "authorName")]
        author_name: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Tool {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Narration {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Citation {
        #[serde(rename = "fileId", skip_serializing_if = "Option::is_none")]
        file_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Image {
        #[serde(rename = "assetPointer")]
        asset_pointer: String,
        /// Not in the declared TS type; present at runtime, see module docs.
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    File {
        #[serde(rename = "assetPointer")]
        asset_pointer: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Marker {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        marker: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        event: Option<String>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    CitationPatch {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        #[serde(rename = "contentReferences")]
        content_references: Vec<Value>,
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Status {
        #[serde(rename = "messageId")]
        message_id: Option<String>,
        status: String,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
    Raw {
        raw: Value,
        #[serde(rename = "displayHidden", skip_serializing_if = "Option::is_none")]
        display_hidden: Option<bool>,
    },
}

impl NormalizedConversationEvent {
    /// Mirrors the `displayHidden` check in `ConversationStreamReducer#push`:
    /// true for an `image` event, or a `file` event whose pointer names the
    /// `sediment://` scheme (used interchangeably with `image` for some
    /// asset kinds upstream).
    pub fn is_image_like(&self) -> bool {
        match self {
            Self::Image { .. } => true,
            Self::File { asset_pointer, .. } => asset_pointer.starts_with("sediment://"),
            _ => false,
        }
    }

    pub fn is_citation_patch(&self) -> bool {
        matches!(self, Self::CitationPatch { .. })
    }

    /// Returns a copy with `displayHidden: true` set, mirroring the
    /// `{ ...event, displayHidden: true }` spread in `push`.
    pub fn with_display_hidden(mut self) -> Self {
        let slot = match &mut self {
            Self::AssistantText { display_hidden, .. }
            | Self::Message { display_hidden, .. }
            | Self::Tool { display_hidden, .. }
            | Self::Narration { display_hidden, .. }
            | Self::Citation { display_hidden, .. }
            | Self::Image { display_hidden, .. }
            | Self::File { display_hidden, .. }
            | Self::Marker { display_hidden, .. }
            | Self::CitationPatch { display_hidden, .. }
            | Self::Status { display_hidden, .. }
            | Self::Raw { display_hidden, .. } => display_hidden,
        };
        *slot = Some(true);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn assistant_text_serializes_without_a_kind_wrapper() {
        let event = NormalizedConversationEvent::AssistantText {
            message_id: Some("m1".to_string()),
            delta: "hi".to_string(),
            text: "hi".to_string(),
            display_hidden: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({"kind": "assistant_text", "messageId": "m1", "delta": "hi", "text": "hi"})
        );
    }

    #[test]
    fn image_events_can_carry_a_title_matching_runtime_output() {
        // Verified against a real scanSpecials() run in Node: an image event
        // constructed from a source object with `title` serializes with
        // "title" present, even though types.ts's image variant omits it.
        let event = NormalizedConversationEvent::Image {
            asset_pointer: "sediment://img1".to_string(),
            title: Some("my chart".to_string()),
            raw: json!({"asset_pointer": "sediment://img1", "title": "my chart"}),
            display_hidden: None,
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "kind": "image",
                "assetPointer": "sediment://img1",
                "title": "my chart",
                "raw": {"asset_pointer": "sediment://img1", "title": "my chart"}
            })
        );
    }

    #[test]
    fn display_hidden_is_omitted_when_absent_and_present_when_set() {
        let event = NormalizedConversationEvent::Status {
            message_id: None,
            status: "in_progress".to_string(),
            display_hidden: None,
        };
        let value = serde_json::to_value(&event).unwrap();
        assert!(value.get("displayHidden").is_none());

        let hidden = event.with_display_hidden();
        let value = serde_json::to_value(&hidden).unwrap();
        assert_eq!(value.get("displayHidden"), Some(&json!(true)));
    }

    #[test]
    fn is_image_like_covers_image_kind_and_sediment_file_pointers() {
        let image = NormalizedConversationEvent::Image {
            asset_pointer: "sediment://x".to_string(),
            title: None,
            raw: Value::Null,
            display_hidden: None,
        };
        assert!(image.is_image_like());

        let sediment_file = NormalizedConversationEvent::File {
            asset_pointer: "sediment://x".to_string(),
            title: None,
            raw: Value::Null,
            display_hidden: None,
        };
        assert!(sediment_file.is_image_like());

        let plain_file = NormalizedConversationEvent::File {
            asset_pointer: "file-service://x".to_string(),
            title: None,
            raw: Value::Null,
            display_hidden: None,
        };
        assert!(!plain_file.is_image_like());
    }
}
