//! Recursive asset/citation discovery over raw stream payloads — port of
//! `scanSpecials` and the message helpers in `packages/protocol/src/sse.ts`.
//!
//! ChatGPT embeds asset pointers and citation objects at unpredictable
//! depths and under varying key names, so rather than relying on the
//! structured patch path alone this walks every value in the tree and picks
//! them out wherever they appear.
//!
//! One deliberate simplification: the TS version threads a `seen` Set to
//! guard against reference cycles and repeated visits to a shared object.
//! A `serde_json::Value` is an owned tree that cannot contain cycles, and
//! JSON parsed from text never has shared references, so no equivalent is
//! needed here.

use crate::events::NormalizedConversationEvent;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// `/(?:file-service|sediment):\/\/[^\s"'<>]+/g`
static ASSET_POINTER_IN_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:file-service|sediment)://[^\s"'<>]+"#).expect("valid regex"));

fn as_str(value: Option<&Value>) -> Option<&str> {
    value?.as_str()
}

/// Mirrors `scanSpecials`, appending every discovered event in traversal
/// order.
pub fn scan_specials(value: &Value, out: &mut Vec<NormalizedConversationEvent>) {
    match value {
        Value::Null => {}

        Value::String(text) => {
            for matched in ASSET_POINTER_IN_TEXT.find_iter(text) {
                let pointer = matched.as_str().to_string();
                let raw = Value::String(text.clone());
                out.push(if pointer.starts_with("sediment://") {
                    NormalizedConversationEvent::Image {
                        asset_pointer: pointer,
                        title: None,
                        raw,
                        display_hidden: None,
                    }
                } else {
                    NormalizedConversationEvent::File {
                        asset_pointer: pointer,
                        title: None,
                        raw,
                        display_hidden: None,
                    }
                });
            }
        }

        Value::Array(items) => {
            for item in items {
                scan_specials(item, out);
            }
        }

        Value::Object(object) => {
            let asset_pointer = as_str(object.get("asset_pointer"));
            let content_type = as_str(object.get("content_type"));

            if let Some(pointer) = asset_pointer {
                let title = as_str(object.get("title"))
                    .or_else(|| as_str(object.get("name")))
                    .map(str::to_string);
                let is_image = content_type == Some("image_asset_pointer")
                    || content_type.is_some_and(|t| t.starts_with("image/"))
                    || pointer.starts_with("sediment://");
                let pointer = pointer.to_string();
                let raw = value.clone();
                out.push(if is_image {
                    NormalizedConversationEvent::Image {
                        asset_pointer: pointer,
                        title,
                        raw,
                        display_hidden: None,
                    }
                } else {
                    NormalizedConversationEvent::File {
                        asset_pointer: pointer,
                        title,
                        raw,
                        display_hidden: None,
                    }
                });
            }

            let metadata = object.get("metadata").and_then(Value::as_object);
            let file_id = as_str(object.get("file_id"))
                .or_else(|| as_str(object.get("fileId")))
                .or_else(|| metadata.and_then(|m| as_str(m.get("file_id"))))
                .map(str::to_string);
            let title = as_str(object.get("title"))
                .or_else(|| as_str(object.get("name")))
                .or_else(|| metadata.and_then(|m| as_str(m.get("title"))))
                .map(str::to_string);

            // Note these are key-presence checks in the original, so an
            // explicitly-null `citation` still marks the object as one.
            let looks_like_citation = content_type.is_some_and(|t| t.contains("citation"))
                || object.contains_key("citation")
                || object.contains_key("citations")
                || object.contains_key("file_citation");
            if looks_like_citation {
                out.push(NormalizedConversationEvent::Citation {
                    file_id,
                    title,
                    raw: value.clone(),
                    display_hidden: None,
                });
            }

            // `asset_pointer` is skipped because it was already consumed
            // above; recursing into it would double-report the pointer as a
            // bare string match.
            for (key, nested) in object {
                if key != "asset_pointer" {
                    scan_specials(nested, out);
                }
            }
        }

        // Numbers and booleans carry nothing to discover.
        Value::Number(_) | Value::Bool(_) => {}
    }
}

/// Mirrors `messageText`: joins the message's string parts, substituting an
/// `asset_pointer` for object parts, dropping empties, separated by a blank
/// line.
pub fn message_text(message: &Value) -> String {
    let parts = message
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array);
    let Some(parts) = parts else {
        return String::new();
    };
    parts
        .iter()
        .map(|part| match part {
            Value::String(text) => text.clone(),
            Value::Object(object) => as_str(object.get("asset_pointer"))
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Mirrors `roleOf`.
pub fn role_of(message: &Value) -> Option<&str> {
    message.get("author")?.as_object()?.get("role")?.as_str()
}

/// Mirrors `authorNameOf`.
pub fn author_name_of(message: &Value) -> Option<&str> {
    message.get("author")?.as_object()?.get("name")?.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scan(value: &Value) -> Vec<NormalizedConversationEvent> {
        let mut out = Vec::new();
        scan_specials(value, &mut out);
        out
    }

    #[test]
    fn pointers_embedded_in_free_text_are_discovered() {
        let events = scan(&json!(
            "see sediment://img-1 and file-service://doc-2 for detail"
        ));
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::Image { asset_pointer, .. } if asset_pointer == "sediment://img-1"
        ));
        assert!(matches!(
            &events[1],
            NormalizedConversationEvent::File { asset_pointer, .. } if asset_pointer == "file-service://doc-2"
        ));
    }

    #[test]
    fn text_pointers_stop_at_quotes_brackets_and_whitespace() {
        // The character class excludes whitespace, quotes and angle brackets
        // so a pointer inside markup or JSON is not over-captured.
        let events = scan(&json!("<a href=\"sediment://img-1\">x</a>"));
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::Image { asset_pointer, .. } if asset_pointer == "sediment://img-1"
        ));
    }

    #[test]
    fn a_string_without_a_pointer_yields_nothing() {
        assert!(scan(&json!("just prose")).is_empty());
        assert!(scan(&json!("https://example.com/not-a-pointer")).is_empty());
    }

    #[test]
    fn scalars_and_null_yield_nothing() {
        for value in [json!(null), json!(42), json!(true), json!(-1.5)] {
            assert!(scan(&value).is_empty(), "{value} should yield nothing");
        }
    }

    #[test]
    fn an_asset_pointer_object_is_classified_by_content_type() {
        let image = scan(&json!({
            "asset_pointer": "file-service://f1",
            "content_type": "image_asset_pointer",
            "title": "chart"
        }));
        assert_eq!(image.len(), 1);
        assert!(matches!(
            &image[0],
            NormalizedConversationEvent::Image { asset_pointer, title, .. }
                if asset_pointer == "file-service://f1" && title.as_deref() == Some("chart")
        ));

        // A MIME-shaped image content type also counts.
        let mime =
            scan(&json!({"asset_pointer": "file-service://f2", "content_type": "image/png"}));
        assert!(matches!(
            &mime[0],
            NormalizedConversationEvent::Image { .. }
        ));

        // Anything else is a file.
        let file =
            scan(&json!({"asset_pointer": "file-service://f3", "content_type": "text/plain"}));
        assert!(matches!(&file[0], NormalizedConversationEvent::File { .. }));
    }

    #[test]
    fn a_sediment_pointer_is_an_image_regardless_of_content_type() {
        let events = scan(&json!({"asset_pointer": "sediment://s1", "content_type": "text/plain"}));
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::Image { .. }
        ));
    }

    #[test]
    fn a_pointer_object_falls_back_to_name_for_its_title() {
        let events = scan(&json!({"asset_pointer": "file-service://f1", "name": "from-name"}));
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::File { title, .. } if title.as_deref() == Some("from-name")
        ));
        // `title` wins over `name` when both are present.
        let both = scan(&json!({
            "asset_pointer": "file-service://f1",
            "title": "from-title",
            "name": "from-name"
        }));
        assert!(matches!(
            &both[0],
            NormalizedConversationEvent::File { title, .. } if title.as_deref() == Some("from-title")
        ));
    }

    #[test]
    fn the_asset_pointer_key_is_not_rescanned_as_a_bare_string() {
        // Recursing into asset_pointer would report the same pointer twice:
        // once structurally and once as a text match.
        let events = scan(&json!({"asset_pointer": "sediment://s1"}));
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn citations_are_detected_by_content_type_or_key_presence() {
        for value in [
            json!({"content_type": "webpage_citation"}),
            json!({"citation": {"x": 1}}),
            json!({"citations": []}),
            json!({"file_citation": {"file_id": "f9"}}),
            // Key presence, so an explicit null still counts.
            json!({"citation": null}),
        ] {
            let events = scan(&value);
            assert!(
                events
                    .iter()
                    .any(|e| matches!(e, NormalizedConversationEvent::Citation { .. })),
                "{value} should be a citation"
            );
        }
        assert!(scan(&json!({"content_type": "text"})).is_empty());
    }

    #[test]
    fn a_citation_resolves_its_file_id_and_title_through_metadata() {
        let events = scan(&json!({
            "citation": {},
            "metadata": {"file_id": "f-meta", "title": "t-meta"}
        }));
        let citation = events
            .iter()
            .find(|e| matches!(e, NormalizedConversationEvent::Citation { .. }))
            .unwrap();
        assert!(matches!(
            citation,
            NormalizedConversationEvent::Citation { file_id, title, .. }
                if file_id.as_deref() == Some("f-meta") && title.as_deref() == Some("t-meta")
        ));

        // Direct keys take precedence over metadata, and fileId is accepted
        // alongside file_id.
        let direct = scan(&json!({"citations": [], "fileId": "f-direct", "title": "t-direct"}));
        let citation = direct
            .iter()
            .find(|e| matches!(e, NormalizedConversationEvent::Citation { .. }))
            .unwrap();
        assert!(matches!(
            citation,
            NormalizedConversationEvent::Citation { file_id, title, .. }
                if file_id.as_deref() == Some("f-direct") && title.as_deref() == Some("t-direct")
        ));
    }

    #[test]
    fn discovery_reaches_arbitrary_depth_through_arrays_and_objects() {
        let events = scan(&json!({
            "a": [{"b": {"c": [{"asset_pointer": "sediment://deep"}]}}]
        }));
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::Image { asset_pointer, .. } if asset_pointer == "sediment://deep"
        ));
    }

    #[test]
    fn an_object_can_yield_both_an_asset_and_a_citation() {
        let events = scan(&json!({
            "asset_pointer": "file-service://f1",
            "citation": {},
            "title": "both"
        }));
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            NormalizedConversationEvent::File { .. }
        ));
        assert!(matches!(
            &events[1],
            NormalizedConversationEvent::Citation { .. }
        ));
    }

    #[test]
    fn message_text_joins_parts_and_substitutes_pointers() {
        assert_eq!(
            message_text(&json!({"content": {"parts": ["one", "two"]}})),
            "one\n\ntwo"
        );
        // Object parts contribute their asset_pointer.
        assert_eq!(
            message_text(&json!({
                "content": {"parts": ["text", {"asset_pointer": "sediment://s1"}]}
            })),
            "text\n\nsediment://s1"
        );
        // Empty and non-string/object parts are dropped.
        assert_eq!(
            message_text(&json!({"content": {"parts": ["a", "", null, 5, {}, "b"]}})),
            "a\n\nb"
        );
        // A message with no content or no parts array yields "".
        assert_eq!(message_text(&json!({})), "");
        assert_eq!(message_text(&json!({"content": {}})), "");
        assert_eq!(
            message_text(&json!({"content": {"parts": "not-an-array"}})),
            ""
        );
    }

    #[test]
    fn role_and_author_name_read_through_the_author_object() {
        let message = json!({"author": {"role": "assistant", "name": "browser"}});
        assert_eq!(role_of(&message), Some("assistant"));
        assert_eq!(author_name_of(&message), Some("browser"));
        assert_eq!(role_of(&json!({})), None);
        assert_eq!(role_of(&json!({"author": "not-an-object"})), None);
        assert_eq!(author_name_of(&json!({"author": {"role": "user"}})), None);
    }
}
