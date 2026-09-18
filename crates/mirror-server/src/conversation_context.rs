//! Pure helper functions for OpenAI request normalization, prompt/history synthesis,
//! model routing, and metadata packing.
//! Port of `apps/server/src/conversation-context.ts`.

#![allow(clippy::collapsible_if)]

use mirror_protocol::events::NormalizedConversationEvent;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutedModel {
    pub model: String,
    pub gizmo_id: Option<String>,
    pub private: Option<bool>,
}

/// Routes models: Custom GPTs and ChatGPT Projects (starting with `g-`)
/// route through `gizmoId`.
pub fn route_model(model: &str, metadata: Option<&HashMap<String, String>>) -> RoutedModel {
    let override_model = metadata.and_then(|m| m.get("mirror_model"));
    let private_mode = metadata.and_then(|m| m.get("private")).map(|v| v == "true");

    if model.starts_with("g-") {
        RoutedModel {
            model: override_model.cloned().unwrap_or_else(|| "auto".to_string()),
            gizmo_id: Some(model.to_string()),
            private: private_mode,
        }
    } else {
        RoutedModel {
            model: override_model.cloned().unwrap_or_else(|| model.to_string()),
            gizmo_id: None,
            private: private_mode,
        }
    }
}

/// Extracts plain text content from an OpenAI message content field (string or array of parts).
pub fn text_content(content: &Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        let parts: Vec<&str> = arr
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect();
        return parts.join("\n");
    }
    String::new()
}

/// Packs ChatGPT-only behavior (like tool executions) into response metadata.
pub fn build_response_metadata(
    events: &[NormalizedConversationEvent],
    _upstream_conversation_id: Option<&str>,
) -> Option<HashMap<String, String>> {
    let mut tool_events = Vec::new();
    for event in events {
        if let NormalizedConversationEvent::Tool { name, status, display_hidden, .. } = event {
            if !display_hidden.unwrap_or(false) {
                tool_events.push(json!({
                    "name": name,
                    "status": status,
                }));
            }
        }
    }
    if !tool_events.is_empty() {
        let mut map = HashMap::new();
        map.insert(
            "mirror_tool_events".to_string(),
            serde_json::to_string(&tool_events).unwrap_or_default(),
        );
        Some(map)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedMessage {
    pub role: String,
    pub content: String,
    pub name: Option<String>,
}

/// Synthesizes an upstream prompt string from normalized conversation history.
pub fn prompt_for(messages: &[NormalizedMessage], continuation: bool) -> String {
    if continuation {
        return messages.last().map(|m| m.content.clone()).unwrap_or_default();
    }
    let system: Vec<&NormalizedMessage> = messages
        .iter()
        .filter(|m| m.role == "system" || m.role == "developer")
        .collect();
    let conversational: Vec<&NormalizedMessage> = messages
        .iter()
        .filter(|m| m.role != "system" && m.role != "developer")
        .collect();

    if messages.len() == 1 && messages[0].role == "user" {
        return messages[0].content.clone();
    }

    let mut sections = Vec::new();
    if !system.is_empty() {
        let sys_content: Vec<&str> = system.iter().map(|m| m.content.as_str()).collect();
        sections.push(format!("Instructions:\n{}", sys_content.join("\n")));
    }
    if !conversational.is_empty() {
        sections.push("Conversation context:".to_string());
        let conv_lines: Vec<String> = conversational
            .iter()
            .map(|m| format!("{}: {}", m.role.to_ascii_uppercase(), m.content))
            .collect();
        sections.push(conv_lines.join("\n\n"));
    }
    sections.join("\n\n")
}

/// Finds the first index where stored conversation messages differ from incoming messages.
pub fn first_history_difference(
    stored: &[(String, String)],
    incoming: &[(String, String)],
) -> usize {
    let mut index = 0;
    while index < stored.len()
        && index < incoming.len()
        && stored[index].0 == incoming[index].0
        && stored[index].1 == incoming[index].1
    {
        index += 1;
    }
    index
}

/// Checks if a hostname points to a public, non-internal IP address.
pub fn is_public_image_host(hostname: &str) -> bool {
    let host = hostname.trim_start_matches('[').trim_end_matches(']');
    let lower = host.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return false;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                if v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_documentation()
                    || v4.octets()[0] == 0
                {
                    return false;
                }
            }
            IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return false;
                }
            }
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_model_standard_slug_and_gizmo() {
        let standard = route_model("gpt-4o", None);
        assert_eq!(
            standard,
            RoutedModel {
                model: "gpt-4o".to_string(),
                gizmo_id: None,
                private: None,
            }
        );

        let mut meta = HashMap::new();
        meta.insert("mirror_model".to_string(), "o1".to_string());
        meta.insert("private".to_string(), "true".to_string());
        let gizmo = route_model("g-1234abcd", Some(&meta));
        assert_eq!(
            gizmo,
            RoutedModel {
                model: "o1".to_string(),
                gizmo_id: Some("g-1234abcd".to_string()),
                private: Some(true),
            }
        );
    }

    #[test]
    fn text_content_string_and_parts() {
        assert_eq!(text_content(&json!("hello")), "hello");
        assert_eq!(
            text_content(&json!([
                {"type": "text", "text": "part 1"},
                {"type": "image_url", "image_url": {"url": "http://foo"}},
                {"type": "text", "text": "part 2"}
            ])),
            "part 1\npart 2"
        );
        assert_eq!(text_content(&json!(123)), "");
    }

    #[test]
    fn prompt_for_synthesizes_context_and_instructions() {
        let messages = vec![
            NormalizedMessage {
                role: "system".to_string(),
                content: "You are helpful.".to_string(),
                name: None,
            },
            NormalizedMessage {
                role: "user".to_string(),
                content: "Hi".to_string(),
                name: None,
            },
        ];
        let p = prompt_for(&messages, false);
        assert!(p.contains("Instructions:\nYou are helpful."));
        assert!(p.contains("Conversation context:"));
        assert!(p.contains("USER: Hi"));

        let single = vec![NormalizedMessage {
            role: "user".to_string(),
            content: "Lone user prompt".to_string(),
            name: None,
        }];
        assert_eq!(prompt_for(&single, false), "Lone user prompt");
    }

    #[test]
    fn first_history_difference_detects_mismatches() {
        let a = vec![
            ("user".to_string(), "1".to_string()),
            ("assistant".to_string(), "2".to_string()),
        ];
        let b = vec![
            ("user".to_string(), "1".to_string()),
            ("assistant".to_string(), "diff".to_string()),
        ];
        assert_eq!(first_history_difference(&a, &b), 1);
        assert_eq!(first_history_difference(&a, &a), 2);
    }

    #[test]
    fn is_public_image_host_blocks_private_and_local() {
        assert!(!is_public_image_host("localhost"));
        assert!(!is_public_image_host("my.localhost"));
        assert!(!is_public_image_host("127.0.0.1"));
        assert!(!is_public_image_host("10.0.0.1"));
        assert!(!is_public_image_host("192.168.1.1"));
        assert!(is_public_image_host("example.com"));
        assert!(is_public_image_host("8.8.8.8"));
    }
}
