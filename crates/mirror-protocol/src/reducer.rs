//! The stream-to-message state machine — port of `ConversationStreamReducer`
//! in `packages/protocol/src/sse.ts`.
//!
//! This is the outer shell around [`crate::patch::apply_message_patch`]: it
//! owns the in-flight assistant message, tracks which messages are
//! first-turn tool narration that should stay hidden from the visible
//! answer, and turns the raw patch/typed/unknown event stream into the
//! stable [`crate::events::NormalizedConversationEvent`] list a caller
//! actually wants. Per the migration plan this is risk item #1 — the wire
//! format is undocumented and reverse engineered, so every branch below
//! mirrors one line of the original, and the whole module is checked against
//! the real implementation's output in `tests`.

use crate::events::NormalizedConversationEvent;
use crate::patch::apply_message_patch;
use crate::scan::{author_name_of, message_text, role_of, scan_specials};
use crate::sse::{Inherited, StreamEvent, parse_sse_event};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;

/// Assistant-authored status cards that are not the normal answer.
const FIRST_TURN_TOOL_NARRATION_CONTENT_TYPES: &[&str] = &[
    "tether_browsing_display",
    "tether_browsing_code",
    "computer_output",
    "computer_initialize_state",
    "system_content",
    "developer_content",
    "system_message",
    "system_error",
    "sonic_webpage",
    "citable_code_output",
    "user_editable_context",
    "model_editable_context",
];

fn is_narration_content_type(content_type: Option<&str>) -> bool {
    content_type.is_some_and(|ct| FIRST_TURN_TOOL_NARRATION_CONTENT_TYPES.contains(&ct))
}

/// `/^(?:python|python_user_visible)(?:\.|$)/`
fn is_python_tool(name: &str) -> bool {
    for prefix in ["python_user_visible", "python"] {
        if let Some(rest) = name.strip_prefix(prefix)
            && (rest.is_empty() || rest.starts_with('.'))
        {
            return true;
        }
    }
    false
}

/// Tools the model can invoke in direct response to something the user asked
/// for in THIS turn (image generation, web browsing/search, canvas, code
/// interpreter). These stay visible even on a gizmo/Project's first upstream
/// turn, unlike quiet initialization-only tools such as file_search /
/// myfiles_browser.
///
/// `/^(?:python|python_user_visible|dalle|image_gen|image_generation|image|
/// text2im|gen_image|drawing_tool|browser|web|canmore|sora|video_gen)
/// (?:[._-]|$)/i`
fn is_always_visible_first_turn_tool(name: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "python_user_visible",
        "python",
        "image_generation",
        "image_gen",
        "image",
        "dalle",
        "text2im",
        "gen_image",
        "drawing_tool",
        "browser",
        "web",
        "canmore",
        "sora",
        "video_gen",
    ];
    let lower = name.to_ascii_lowercase();
    for prefix in PREFIXES {
        if let Some(rest) = lower.strip_prefix(prefix)
            && (rest.is_empty() || rest.starts_with(['.', '_', '-']))
        {
            return true;
        }
    }
    false
}

/// JS truthiness for a JSON value: absent/null/false/0/""/NaN are falsy,
/// everything else (including empty arrays and objects) is truthy.
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn as_str(value: Option<&Value>) -> Option<&str> {
    value?.as_str()
}

fn content_of(message: &Value) -> Option<&Value> {
    message.get("content").filter(|v| v.is_object())
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ReducerOptions {
    /// First upstream turn of a Custom GPT/Project: hide the quiet
    /// initialization-only tool activity (file_search/myfiles_browser
    /// retrieval, raw reasoning/system-content framing, the "thinking..."
    /// commentary preamble) that fires automatically before the model starts
    /// answering. Tools the user directly asked for this turn stay visible,
    /// as does the final answer text. Subsequent turns are unaffected.
    pub suppress_first_turn_tool_narration: bool,
}

pub struct ConversationStreamReducer {
    opts: ReducerOptions,
    display_hidden: bool,
    last_path: String,
    last_op: String,
    current_message: Option<Value>,
    current_message_id: Option<String>,
    current_assistant_id: Option<String>,
    assistant_texts: HashMap<String, String>,
    conversation_id: Option<String>,
    resume_token: Option<String>,
    finished: bool,
    error_code: Option<String>,
    final_assistant_id: Option<String>,
    normalized: Vec<NormalizedConversationEvent>,
}

impl ConversationStreamReducer {
    pub fn new(opts: ReducerOptions) -> Self {
        Self {
            opts,
            display_hidden: false,
            last_path: String::new(),
            last_op: String::new(),
            current_message: None,
            current_message_id: None,
            current_assistant_id: None,
            assistant_texts: HashMap::new(),
            conversation_id: None,
            resume_token: None,
            finished: false,
            error_code: None,
            final_assistant_id: None,
            normalized: Vec::new(),
        }
    }

    /// Mirrors `feed`: parses one SSE data payload against the current
    /// path/op inheritance context and applies it.
    pub fn feed(&mut self, payload: &str) -> StreamEvent {
        let inherited = Inherited {
            path: self.last_path.clone(),
            op: self.last_op.clone(),
        };
        let event = parse_sse_event(payload, &inherited);
        self.apply(event.clone());
        event
    }

    /// Mirrors `drainEvents`: takes and clears the accumulated event buffer.
    pub fn drain_events(&mut self) -> Vec<NormalizedConversationEvent> {
        std::mem::take(&mut self.normalized)
    }

    fn push(&mut self, event: NormalizedConversationEvent) {
        // Citation-patch data carries no visible text of its own to
        // suppress, and it must reach the message it patches regardless of
        // ambient display_hidden state (e.g. left over from the message
        // that was current when this patch event arrived), or every
        // citation on a suppressed turn silently disappears.
        let is_image = event.is_image_like();
        let is_citation_patch = event.is_citation_patch();
        let should_hide = self.display_hidden && !is_image && !is_citation_patch;
        self.normalized.push(if should_hide {
            event.with_display_hidden()
        } else {
            event
        });
    }

    fn apply(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::Done => {
                self.finished = true;
            }

            StreamEvent::ResumeToken(raw) => {
                self.resume_token = as_str(raw.get("token")).map(str::to_string);
                self.conversation_id = as_str(raw.get("conversation_id")).map(str::to_string);
            }

            StreamEvent::Typed { r#type, raw } => {
                // Citation data ChatGPT resolves after the initial text
                // (sidebar/popup reference descriptions, grouped results)
                // arrives via its own content_references_patch typed event,
                // not embedded in the message object. Normalize it
                // unconditionally, bypassing the narration-visibility gate
                // below entirely, or dropping it on a suppressed first turn
                // would silently break every citation on that turn.
                if r#type == "content_references_patch" {
                    let message_id = as_str(raw.get("message_id")).map(str::to_string);
                    let content_references = raw
                        .get("content_references")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    self.push(NormalizedConversationEvent::CitationPatch {
                        message_id,
                        content_references,
                        raw,
                        display_hidden: None,
                    });
                    return;
                }

                let previous_visibility = self.display_hidden;
                let name = as_str(raw.get("tool_name"))
                    .or_else(|| as_str(raw.get("name")))
                    .unwrap_or("");
                self.display_hidden = self.opts.suppress_first_turn_tool_narration
                    && !is_always_visible_first_turn_tool(name)
                    && !is_always_visible_first_turn_tool(&r#type);
                self.apply_typed(&r#type, &raw);
                let mut discovered = Vec::new();
                scan_specials(&raw, &mut discovered);
                for found in discovered {
                    self.push(found);
                }
                self.display_hidden = previous_visibility;
            }

            StreamEvent::Unknown(raw) => {
                self.push(NormalizedConversationEvent::Raw {
                    raw: raw.clone(),
                    display_hidden: None,
                });
                let mut discovered = Vec::new();
                scan_specials(&raw, &mut discovered);
                for found in discovered {
                    self.push(found);
                }
            }

            // ProtocolVersion is silently dropped, matching `if (event.kind
            // !== "patch") return;`.
            StreamEvent::ProtocolVersion(_) => {}

            StreamEvent::Patch(patch) => {
                self.last_path = patch.p.clone();
                self.last_op = patch.o.clone();

                if patch.o == "patch"
                    && let Value::Array(items) = &patch.v
                {
                    for sub in items {
                        let Some(sub_obj) = sub.as_object() else {
                            continue;
                        };
                        let (Some(p), Some(o)) = (
                            sub_obj.get("p").and_then(Value::as_str),
                            sub_obj.get("o").and_then(Value::as_str),
                        ) else {
                            continue;
                        };
                        let v = sub_obj.get("v").cloned().unwrap_or(Value::Null);
                        self.apply_op(p, o, &v);
                        let mut discovered = Vec::new();
                        scan_specials(sub, &mut discovered);
                        for found in discovered {
                            self.push(found);
                        }
                    }
                    return;
                }

                self.apply_op(&patch.p, &patch.o, &patch.v);
                let mut discovered = Vec::new();
                scan_specials(&patch.v, &mut discovered);
                for found in discovered {
                    self.push(found);
                }
            }
        }
    }

    fn apply_typed(&mut self, r#type: &str, raw: &Value) {
        if r#type == "message_marker" {
            let message_id = as_str(raw.get("message_id")).map(str::to_string);
            let marker = as_str(raw.get("marker")).map(str::to_string);
            let event_field = as_str(raw.get("event")).map(str::to_string);

            // This is the exact continuity marker observed in current
            // ChatGPT Web.
            let is_final_marker = message_id.is_some()
                && event_field.as_deref() == Some("last")
                && (marker.as_deref() == Some("last_token") || marker.is_none());
            if is_final_marker {
                self.final_assistant_id = message_id.clone();
            }

            self.push(NormalizedConversationEvent::Marker {
                message_id,
                marker,
                event: event_field,
                raw: raw.clone(),
                display_hidden: None,
            });
            return;
        }

        // Tool-call/status typed events vary over time. Preserve them and
        // promote obvious tool names into a stable event.
        let tool_name = as_str(raw.get("tool_name"))
            .or_else(|| as_str(raw.get("name")))
            .map(str::to_string)
            .or_else(|| r#type.contains("tool").then(|| r#type.to_string()));

        if let Some(name) = tool_name {
            self.push(NormalizedConversationEvent::Tool {
                message_id: as_str(raw.get("message_id")).map(str::to_string),
                name,
                status: as_str(raw.get("status")).map(str::to_string),
                raw: raw.clone(),
                display_hidden: None,
            });
        } else {
            self.push(NormalizedConversationEvent::Raw {
                raw: raw.clone(),
                display_hidden: None,
            });
        }
    }

    fn set_current_message(&mut self, message: Value) {
        let message_id = as_str(message.get("id")).map(str::to_string);
        let role = role_of(&message).map(str::to_string);
        let content = content_of(&message);
        let content_type = content
            .and_then(|c| as_str(c.get("content_type")))
            .map(str::to_string);
        let author_name = author_name_of(&message).map(str::to_string);
        let channel = as_str(message.get("channel")).map(str::to_string);
        let recipient_raw = message.get("recipient");
        let recipient_str = recipient_raw.and_then(Value::as_str).unwrap_or("");

        let python = is_python_tool(author_name.as_deref().unwrap_or(""))
            || is_python_tool(recipient_str);
        let is_visible_first_turn_tool = python
            || is_always_visible_first_turn_tool(author_name.as_deref().unwrap_or(""))
            || is_always_visible_first_turn_tool(recipient_str);

        let has_image_content = content_type.as_deref() == Some("image_asset_pointer")
            || content_type.as_deref() == Some("image")
            || content_type.as_deref().is_some_and(|ct| ct.starts_with("image/"))
            || content
                .and_then(|c| c.get("parts"))
                .and_then(Value::as_array)
                .is_some_and(|parts| {
                    parts.iter().any(|part| {
                        let Some(part_obj) = part.as_object() else {
                            return false;
                        };
                        part_obj.get("content_type").and_then(Value::as_str)
                            == Some("image_asset_pointer")
                            || part_obj
                                .get("asset_pointer")
                                .and_then(Value::as_str)
                                .is_some_and(|p| {
                                    p.starts_with("sediment://") || p.starts_with("file-service://")
                                })
                    })
                });
        let is_protected_output = is_visible_first_turn_tool || has_image_content;

        let recipient_truthy_not_all =
            js_truthy(recipient_raw) && recipient_raw.and_then(Value::as_str) != Some("all");

        self.display_hidden = channel.as_deref() == Some("analysis")
            || (self.opts.suppress_first_turn_tool_narration
                && !is_protected_output
                && (role.as_deref() != Some("assistant")
                    || author_name.is_some()
                    || channel.as_deref() == Some("commentary")
                    || recipient_truthy_not_all
                    || content_type.as_deref() == Some("reasoning_recap")
                    || content_type.as_deref() == Some("summary")
                    || is_narration_content_type(content_type.as_deref())));

        self.current_message_id = message_id.clone();
        self.push(NormalizedConversationEvent::Message {
            message_id: message_id.clone(),
            role: role.clone(),
            content_type: content_type.clone(),
            author_name: author_name.clone(),
            raw: message.clone(),
            display_hidden: None,
        });

        // Real captures of a gizmo/Project's first turn show the "thinking
        // preamble"/pre-tool-call narration arriving as an ordinary
        // author.role === "assistant", recipient === "all" message on
        // channel === "commentary" - distinct from channel === "analysis"
        // (internal reasoning, always hidden above) and from the tool
        // call/result messages themselves, which carry a specific non-"all"
        // recipient and are therefore already excluded by the recipient
        // check below regardless of this flag.
        let is_first_turn_tool_narration = self.opts.suppress_first_turn_tool_narration
            && !is_visible_first_turn_tool
            && channel.as_deref() != Some("analysis")
            && (channel.as_deref() == Some("commentary")
                || is_narration_content_type(content_type.as_deref()));

        let no_recipient_or_all =
            !js_truthy(recipient_raw) || recipient_raw.and_then(Value::as_str) == Some("all");

        if role.as_deref() == Some("assistant")
            && message_id.is_some()
            && channel.as_deref() != Some("analysis")
            && no_recipient_or_all
            && content_type.as_deref() != Some("reasoning_recap")
            && content_type.as_deref() != Some("summary")
            && !is_first_turn_tool_narration
            && !self.display_hidden
        {
            let id = message_id.clone().expect("checked is_some above");
            self.current_assistant_id = Some(id.clone());
            let previous = self.assistant_texts.get(&id).cloned();
            let next = message_text(&message);
            self.assistant_texts.insert(id.clone(), next.clone());
            if next != previous.clone().unwrap_or_default() {
                let delta = match &previous {
                    Some(p) if next.starts_with(p.as_str()) => next[p.len()..].to_string(),
                    _ => next.clone(),
                };
                self.push(NormalizedConversationEvent::AssistantText {
                    message_id: Some(id),
                    delta,
                    text: next,
                    display_hidden: None,
                });
            }
        }

        if is_first_turn_tool_narration {
            // Keep the original narration for diagnostics without treating
            // it as a visible tool or forcing rich-output buffering.
            // Narration requires either a listed content type or commentary.
            let name = content_type
                .clone()
                .or_else(|| channel.clone())
                .unwrap_or_default();
            self.push(NormalizedConversationEvent::Narration {
                message_id: message_id.clone(),
                name,
                status: as_str(message.get("status")).map(str::to_string),
                raw: message.clone(),
                display_hidden: None,
            });
            self.current_message = Some(message);
            return;
        }

        let is_tool = role.as_deref() == Some("tool")
            || author_name.is_some()
            || content_type.as_deref() == Some("computer_initialize_state")
            || content_type.as_deref() == Some("computer_output");
        if is_tool {
            let name = author_name.or(content_type).unwrap_or_else(|| "tool".to_string());
            self.push(NormalizedConversationEvent::Tool {
                message_id,
                name,
                status: as_str(message.get("status")).map(str::to_string),
                raw: message.clone(),
                display_hidden: None,
            });
        }

        self.current_message = Some(message);
    }

    fn apply_op(&mut self, path: &str, op: &str, value: &Value) {
        if path.is_empty() && (op == "add" || op == "replace") && value.is_object() {
            if let Some(message) = value.get("message").filter(|m| m.is_object()) {
                self.set_current_message(message.clone());
            }
            if let Some(cid) = value.get("conversation_id").and_then(Value::as_str) {
                self.conversation_id = Some(cid.to_string());
            }
            if let Some(code) = value.get("error_code").and_then(Value::as_str) {
                self.error_code = Some(code.to_string());
            }
            return;
        }

        if path == "/message/id" && self.current_message.is_some() {
            if let Value::String(id) = value {
                let mut message = self.current_message.take().expect("checked is_some");
                if let Value::Object(map) = &mut message {
                    map.insert("id".to_string(), Value::String(id.clone()));
                }
                self.current_message_id = Some(id.clone());
                self.set_current_message(message);
            }
            return;
        }

        if path.starts_with("/message/") && path != "/message/status" && self.current_message.is_some()
        {
            let mut message = self.current_message.take().expect("checked is_some");
            // Both of apply_message_patch's guards (an append into a
            // not-yet-array parts list, and a prototype-polluting key) are a
            // `return` from the WHOLE of applyOp in the original, not just a
            // skipped mutation — set_current_message (and the message/
            // assistant_text/tool events it can emit) must not fire for a
            // skipped patch, or a rejected patch would still spuriously
            // re-announce the message as if it had changed.
            match apply_message_patch(&mut message, path, op, value) {
                crate::patch::PatchOutcome::Applied => self.set_current_message(message),
                crate::patch::PatchOutcome::Skipped => self.current_message = Some(message),
            }
            return;
        }

        if path == "/message/status"
            && self.current_message.is_some()
            && let Value::String(status) = value
        {
            if let Some(Value::Object(map)) = self.current_message.as_mut() {
                map.insert("status".to_string(), Value::String(status.clone()));
            }
            self.push(NormalizedConversationEvent::Status {
                message_id: self.current_message_id.clone(),
                status: status.clone(),
                display_hidden: None,
            });
            let is_assistant = self
                .current_message
                .as_ref()
                .and_then(|m| role_of(m))
                == Some("assistant");
            if status == "finished_successfully" && is_assistant && self.current_message_id.is_some()
            {
                if self.final_assistant_id.is_none() {
                    self.final_assistant_id = self.current_message_id.clone();
                }
            }
        }
    }

    // ---- accessors, mirroring the TS getters --------------------------

    pub fn text(&self) -> &str {
        static EMPTY: LazyLock<String> = LazyLock::new(String::new);
        self.current_assistant_id
            .as_ref()
            .and_then(|id| self.assistant_texts.get(id))
            .unwrap_or(&EMPTY)
    }

    pub fn role(&self) -> Option<&str> {
        self.current_message.as_ref().and_then(role_of)
    }

    pub fn status(&self) -> Option<&str> {
        self.current_message
            .as_ref()
            .and_then(|m| m.get("status"))
            .and_then(Value::as_str)
    }

    pub fn is_done(&self) -> bool {
        self.finished
    }

    pub fn conversation_id_value(&self) -> Option<&str> {
        self.conversation_id.as_deref()
    }

    pub fn current_assistant_message_id(&self) -> Option<&str> {
        self.final_assistant_id
            .as_deref()
            .or(self.current_assistant_id.as_deref())
    }

    pub fn error(&self) -> Option<&str> {
        self.error_code.as_deref()
    }

    /// Tracked internally like the TS field, though — as in the original —
    /// nothing currently reads it; `client.rs`'s caller uses `resume_token`
    /// events for resumption at the HTTP layer, not this getter.
    pub fn resume_token(&self) -> Option<&str> {
        self.resume_token.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Runs a stream of raw patch/typed frames plus a trailing `[DONE]`
    /// through a fresh reducer, mirroring the Node harness used to capture
    /// fixtures from the real `packages/protocol/dist/sse.js`.
    fn run(opts: ReducerOptions, frames: &[Value]) -> Value {
        let mut reducer = ConversationStreamReducer::new(opts);
        for frame in frames {
            reducer.feed(&frame.to_string());
        }
        reducer.feed("[DONE]");
        let events: Vec<Value> = reducer
            .drain_events()
            .into_iter()
            .map(|e| {
                let mut v = serde_json::to_value(&e).unwrap();
                // The Node fixture harness spread `raw: undefined`, which
                // JSON.stringify drops; strip it here the same way so the
                // comparison focuses on the fields both sides actually
                // assert on.
                v.as_object_mut().unwrap().remove("raw");
                v
            })
            .collect();
        json!({
            "text": reducer.text(),
            "role": reducer.role(),
            "status": reducer.status(),
            "isDone": reducer.is_done(),
            "conversationIdValue": reducer.conversation_id_value(),
            "currentAssistantMessageId": reducer.current_assistant_message_id(),
            "error": reducer.error(),
            "events": events,
        })
    }

    fn opts(suppress: bool) -> ReducerOptions {
        ReducerOptions {
            suppress_first_turn_tool_narration: suppress,
        }
    }

    /// All ten fixtures below were captured by running the exact same input
    /// frames through the real `ConversationStreamReducer` in
    /// `packages/protocol/dist/sse.js` via Node, not derived from this port.
    /// This is the parity oracle for risk item #1 in the migration plan.

    #[test]
    fn fixture_1_plain_streamed_answer() {
        let frames = [
            json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": [""]}, "status": "in_progress"}, "conversation_id": "c1"}, "p": "", "o": "add"}),
            json!({"v": "Hello", "p": "/message/content/parts/0", "o": "append"}),
            json!({"v": " world", "p": "/message/content/parts/0", "o": "append"}),
            json!({"v": "finished_successfully", "p": "/message/status", "o": "replace"}),
        ];
        let expected = json!({
            "text": "Hello world", "role": "assistant", "status": "finished_successfully",
            "isDone": true, "conversationIdValue": "c1", "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
                {"kind": "assistant_text", "messageId": "m1", "delta": "Hello", "text": "Hello"},
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
                {"kind": "assistant_text", "messageId": "m1", "delta": " world", "text": "Hello world"},
                {"kind": "status", "messageId": "m1", "status": "finished_successfully"},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_2_message_marker_continuity() {
        let frames = [
            json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": ["hi"]}, "status": "in_progress"}}, "p": "", "o": "add"}),
            json!({"type": "message_marker", "message_id": "m1", "event": "last"}),
        ];
        let expected = json!({
            "text": "hi", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
                {"kind": "assistant_text", "messageId": "m1", "delta": "hi", "text": "hi"},
                {"kind": "marker", "messageId": "m1", "event": "last"},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_3_suppressed_tool_narration_hides_file_search() {
        let frames = [
            json!({"v": {"message": {"id": "t1", "author": {"role": "tool", "name": "file_search"}, "recipient": "file_search", "channel": "commentary", "content": {"content_type": "text", "parts": ["searching"]}, "status": "in_progress"}}, "p": "", "o": "add"}),
            json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "recipient": "all", "content": {"content_type": "text", "parts": ["The answer is 42"]}, "status": "in_progress"}}, "p": "", "o": "add"}),
        ];
        let expected = json!({
            "text": "The answer is 42", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "t1", "role": "tool", "contentType": "text", "authorName": "file_search", "displayHidden": true},
                {"kind": "narration", "messageId": "t1", "name": "text", "status": "in_progress", "displayHidden": true},
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
                {"kind": "assistant_text", "messageId": "m1", "delta": "The answer is 42", "text": "The answer is 42"},
            ]
        });
        assert_eq!(run(opts(true), &frames), expected);
    }

    #[test]
    fn fixture_4_suppressed_narration_keeps_python_tool_visible() {
        let frames = [json!({"v": {"message": {"id": "p1", "author": {"role": "assistant", "name": "python"}, "recipient": "python", "channel": "commentary", "content": {"content_type": "code", "parts": ["print(1)"]}, "status": "in_progress"}}, "p": "", "o": "add"})];
        let expected = json!({
            "text": "", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": null, "error": null,
            "events": [
                {"kind": "message", "messageId": "p1", "role": "assistant", "contentType": "code", "authorName": "python"},
                {"kind": "tool", "messageId": "p1", "name": "python", "status": "in_progress"},
            ]
        });
        assert_eq!(run(opts(true), &frames), expected);
    }

    #[test]
    fn fixture_5_content_references_patch_bypasses_suppression() {
        let frames = [
            json!({"v": {"message": {"id": "t1", "author": {"role": "tool", "name": "browser"}, "recipient": "browser", "channel": "commentary", "content": {"content_type": "text", "parts": ["x"]}, "status": "in_progress"}}, "p": "", "o": "add"}),
            json!({"type": "content_references_patch", "message_id": "m1", "content_references": [{"type": "webpage", "url": "https://x.com"}]}),
        ];
        let expected = json!({
            "text": "", "role": "tool", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": null, "error": null,
            "events": [
                {"kind": "message", "messageId": "t1", "role": "tool", "contentType": "text", "authorName": "browser"},
                {"kind": "tool", "messageId": "t1", "name": "browser", "status": "in_progress"},
                {"kind": "citation_patch", "messageId": "m1", "contentReferences": [{"type": "webpage", "url": "https://x.com"}]},
            ]
        });
        assert_eq!(run(opts(true), &frames), expected);
    }

    #[test]
    fn fixture_6_nested_patch_op_array() {
        let frames = [
            json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "content": {"content_type": "text", "parts": [""]}, "metadata": {}, "status": "in_progress"}}, "p": "", "o": "add"}),
            json!({"v": [{"p": "/content/parts/0", "o": "append", "v": "hi"}, {"p": "/metadata/x", "o": "add", "v": 1}], "p": "/message", "o": "patch"}),
        ];
        // Only the initial "add" produces a message event: the nested
        // sub-ops route through apply_op directly (not through the
        // /message/... generic patch branch's own set_current_message
        // call), matching upstream exactly - see the module-level notes on
        // why this looks surprising at first glance.
        let expected = json!({
            "text": "", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_7_append_into_missing_parts_array_produces_no_extra_events() {
        // The append is silently skipped (no parts array exists yet), and
        // critically the message must NOT be spuriously re-announced -
        // exactly the bug this port almost shipped with (see the comment at
        // the /message/... branch in apply_op).
        let frames = [
            json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "content": {"content_type": "text"}, "status": "in_progress"}}, "p": "", "o": "add"}),
            json!({"v": "x", "p": "/message/content/parts/0", "o": "append"}),
        ];
        let expected = json!({
            "text": "", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "text", "authorName": null},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_8_image_asset_in_message_content() {
        let frames = [json!({"v": {"message": {"id": "m1", "author": {"role": "assistant"}, "content": {"content_type": "multimodal_text", "parts": [{"asset_pointer": "sediment://img1", "content_type": "image_asset_pointer"}]}, "status": "in_progress"}}, "p": "", "o": "add"})];
        let expected = json!({
            "text": "sediment://img1", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": "m1", "error": null,
            "events": [
                {"kind": "message", "messageId": "m1", "role": "assistant", "contentType": "multimodal_text", "authorName": null},
                {"kind": "assistant_text", "messageId": "m1", "delta": "sediment://img1", "text": "sediment://img1"},
                {"kind": "image", "assetPointer": "sediment://img1"},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_9_error_code() {
        let frames = [json!({"v": {"error_code": "content_filter"}, "p": "", "o": "add"})];
        let expected = json!({
            "text": "", "role": null, "status": null, "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": null, "error": "content_filter",
            "events": []
        });
        assert_eq!(run(opts(false), &frames), expected);
    }

    #[test]
    fn fixture_10_reasoning_recap_excluded_from_assistant_text() {
        let frames = [json!({"v": {"message": {"id": "r1", "author": {"role": "assistant"}, "content": {"content_type": "reasoning_recap", "parts": ["thinking..."]}, "status": "in_progress"}}, "p": "", "o": "add"})];
        let expected = json!({
            "text": "", "role": "assistant", "status": "in_progress", "isDone": true,
            "conversationIdValue": null, "currentAssistantMessageId": null, "error": null,
            "events": [
                {"kind": "message", "messageId": "r1", "role": "assistant", "contentType": "reasoning_recap", "authorName": null},
            ]
        });
        assert_eq!(run(opts(false), &frames), expected);
    }
}
