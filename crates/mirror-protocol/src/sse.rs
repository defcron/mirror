//! ChatGPT Web conversation SSE framing and event classification — a port of
//! the framing/parsing half of `packages/protocol/src/sse.ts`.
//!
//! The stream uses compressed JSON-patch events: `p`/`o` may be omitted and
//! inherit the preceding path/op. Typed events (message_marker, input_message,
//! title_generation, tool events, ...) are interleaved with patch data.
//!
//! The stateful `ConversationStreamReducer` that consumes these events is the
//! most intricate piece of the protocol and is ported separately.

use serde_json::Value;

/// Mirrors `iterSseDataLines`: yields the trimmed payload of every `data:`
/// line, skipping empty payloads and non-`data:` lines.
pub fn iter_sse_data_lines(raw: &str) -> impl Iterator<Item = &str> {
    raw.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|payload| !payload.is_empty())
}

/// Incrementally frames SSE across arbitrary network chunk and CRLF
/// boundaries — mirrors `SseFrameDecoder`.
#[derive(Debug, Default)]
pub struct SseFrameDecoder {
    buffer: String,
}

impl SseFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append `text` and return every complete frame it completed. A frame
    /// ends at a blank line (`\n\n`, `\r\n\r\n`, or either mixed form),
    /// matching the upstream `/\r?\n\r?\n/` boundary.
    pub fn push(&mut self, text: &str) -> Vec<String> {
        self.buffer.push_str(text);
        let mut frames = Vec::new();
        while let Some((index, length)) = find_blank_line(&self.buffer) {
            frames.push(self.buffer[..index].to_string());
            self.buffer = self.buffer[index + length..].to_string();
        }
        frames
    }

    /// Flush any trailing unterminated frame — mirrors `finish()`, including
    /// trimming it and dropping it entirely when blank.
    pub fn finish(&mut self) -> Vec<String> {
        let tail = self.buffer.trim().to_string();
        self.buffer.clear();
        if tail.is_empty() {
            Vec::new()
        } else {
            vec![tail]
        }
    }
}

/// Finds the first `\r?\n\r?\n` boundary, returning its byte offset and
/// length. Prefers the longest match at a given position so a `\r\n\r\n`
/// boundary is consumed whole rather than leaving a stray `\r`.
fn find_blank_line(haystack: &str) -> Option<(usize, usize)> {
    let bytes = haystack.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Each arm matches one `\r?\n\r?\n` shape, longest first.
        for candidate in [b"\r\n\r\n".as_slice(), b"\r\n\n", b"\n\r\n", b"\n\n"] {
            if bytes[i..].starts_with(candidate) {
                return Some((i, candidate.len()));
            }
        }
        i += 1;
    }
    None
}

/// Inherited `p`/`o` context for compressed patch events.
#[derive(Debug, Clone)]
pub struct Inherited {
    pub path: String,
    pub op: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PatchEvent {
    pub p: String,
    pub o: String,
    pub v: Value,
    pub c: Option<f64>,
}

/// Mirrors the `StreamEvent` discriminated union.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Done,
    ProtocolVersion(String),
    ResumeToken(Value),
    Typed {
        r#type: String,
        raw: Value,
    },
    Patch(PatchEvent),
    /// `raw` is the original payload string when JSON parsing failed, and the
    /// parsed value otherwise — matching upstream's two `unknown` shapes.
    Unknown(Value),
}

fn is_plain_object(value: &Value) -> bool {
    value.is_object()
}

/// Mirrors `parseSseEvent`. The classification order is significant and
/// preserved exactly.
pub fn parse_sse_event(payload: &str, inherited: &Inherited) -> StreamEvent {
    if payload == "[DONE]" {
        return StreamEvent::Done;
    }

    let Ok(parsed) = serde_json::from_str::<Value>(payload) else {
        // Upstream returns the raw *string* here, not a parsed value.
        return StreamEvent::Unknown(Value::String(payload.to_string()));
    };

    if let Value::String(version) = &parsed {
        return StreamEvent::ProtocolVersion(version.clone());
    }

    if !is_plain_object(&parsed) {
        return StreamEvent::Unknown(parsed);
    }

    let object = parsed.as_object().expect("checked is_object");

    if object.get("type").and_then(Value::as_str) == Some("resume_conversation_token") {
        return StreamEvent::ResumeToken(parsed);
    }

    if let Some(type_) = object.get("type").and_then(Value::as_str) {
        return StreamEvent::Typed {
            r#type: type_.to_string(),
            raw: parsed,
        };
    }

    if object.contains_key("v") {
        let p = object
            .get("p")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| inherited.path.clone());
        let o = object
            .get("o")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| inherited.op.clone());
        return StreamEvent::Patch(PatchEvent {
            p,
            o,
            v: object.get("v").cloned().unwrap_or(Value::Null),
            c: object.get("c").and_then(Value::as_f64),
        });
    }

    StreamEvent::Unknown(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inherited() -> Inherited {
        Inherited {
            path: "/message/content/parts/0".to_string(),
            op: "append".to_string(),
        }
    }

    #[test]
    fn iter_data_lines_keeps_only_non_empty_data_payloads() {
        let raw = "event: x\ndata: hello\ndata:  spaced  \n\ndata:\ndata: [DONE]\nother: y";
        let lines: Vec<&str> = iter_sse_data_lines(raw).collect();
        assert_eq!(lines, vec!["hello", "spaced", "[DONE]"]);
    }

    #[test]
    fn iter_data_lines_handles_crlf_line_endings() {
        let raw = "data: a\r\ndata: b\r\n";
        let lines: Vec<&str> = iter_sse_data_lines(raw).collect();
        assert_eq!(lines, vec!["a", "b"]);
    }

    #[test]
    fn frame_decoder_splits_on_blank_lines() {
        let mut decoder = SseFrameDecoder::new();
        assert_eq!(
            decoder.push("data: one\n\ndata: two\n\n"),
            vec!["data: one".to_string(), "data: two".to_string()]
        );
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn frame_decoder_reassembles_frames_split_across_chunks() {
        let mut decoder = SseFrameDecoder::new();
        assert!(decoder.push("data: par").is_empty());
        assert!(decoder.push("tial").is_empty());
        assert_eq!(decoder.push("\n\n"), vec!["data: partial".to_string()]);
    }

    #[test]
    fn frame_decoder_handles_a_boundary_split_across_chunks() {
        let mut decoder = SseFrameDecoder::new();
        assert!(decoder.push("data: x\r\n").is_empty());
        assert_eq!(decoder.push("\r\ndata: y"), vec!["data: x".to_string()]);
        // The unterminated tail comes out of finish(), trimmed.
        assert_eq!(decoder.finish(), vec!["data: y".to_string()]);
    }

    #[test]
    fn frame_decoder_consumes_a_crlf_crlf_boundary_whole() {
        // If the longest-match preference were wrong, a stray "\r" would be
        // left at the head of the next frame.
        let mut decoder = SseFrameDecoder::new();
        assert_eq!(
            decoder.push("a\r\n\r\nb\r\n\r\n"),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn frame_decoder_finish_drops_a_blank_tail() {
        let mut decoder = SseFrameDecoder::new();
        decoder.push("  \n  ");
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn done_sentinel_is_recognized() {
        assert_eq!(parse_sse_event("[DONE]", &inherited()), StreamEvent::Done);
    }

    #[test]
    fn invalid_json_yields_unknown_carrying_the_raw_string() {
        assert_eq!(
            parse_sse_event("not json {", &inherited()),
            StreamEvent::Unknown(Value::String("not json {".to_string()))
        );
    }

    #[test]
    fn a_bare_json_string_is_a_protocol_version() {
        assert_eq!(
            parse_sse_event("\"delta_v1\"", &inherited()),
            StreamEvent::ProtocolVersion("delta_v1".to_string())
        );
    }

    #[test]
    fn non_object_json_yields_unknown_carrying_the_parsed_value() {
        assert_eq!(
            parse_sse_event("[1,2]", &inherited()),
            StreamEvent::Unknown(json!([1, 2]))
        );
        assert_eq!(
            parse_sse_event("null", &inherited()),
            StreamEvent::Unknown(Value::Null)
        );
        assert_eq!(
            parse_sse_event("42", &inherited()),
            StreamEvent::Unknown(json!(42))
        );
    }

    #[test]
    fn resume_token_is_matched_before_the_generic_typed_arm() {
        let payload = r#"{"type":"resume_conversation_token","token":"abc"}"#;
        assert_eq!(
            parse_sse_event(payload, &inherited()),
            StreamEvent::ResumeToken(json!({"type":"resume_conversation_token","token":"abc"}))
        );
    }

    #[test]
    fn a_string_type_field_yields_a_typed_event() {
        let payload = r#"{"type":"title_generation","title":"Hi"}"#;
        assert_eq!(
            parse_sse_event(payload, &inherited()),
            StreamEvent::Typed {
                r#type: "title_generation".to_string(),
                raw: json!({"type":"title_generation","title":"Hi"}),
            }
        );
    }

    #[test]
    fn a_non_string_type_field_falls_through_to_the_patch_or_unknown_arms() {
        // `typeof parsed.type === "string"` is false for a numeric type, so
        // a `v` key still wins and produces a patch.
        assert_eq!(
            parse_sse_event(r#"{"type":7,"v":"x"}"#, &inherited()),
            StreamEvent::Patch(PatchEvent {
                p: "/message/content/parts/0".to_string(),
                o: "append".to_string(),
                v: json!("x"),
                c: None,
            })
        );
        // Without `v`, it is unknown.
        assert_eq!(
            parse_sse_event(r#"{"type":7}"#, &inherited()),
            StreamEvent::Unknown(json!({"type":7}))
        );
    }

    #[test]
    fn patch_events_inherit_missing_path_and_op() {
        assert_eq!(
            parse_sse_event(r#"{"v":"hello"}"#, &inherited()),
            StreamEvent::Patch(PatchEvent {
                p: "/message/content/parts/0".to_string(),
                o: "append".to_string(),
                v: json!("hello"),
                c: None,
            })
        );
    }

    #[test]
    fn patch_events_use_explicit_path_op_and_counter_when_present() {
        assert_eq!(
            parse_sse_event(
                r#"{"p":"/message/id","o":"replace","v":"m1","c":3}"#,
                &inherited()
            ),
            StreamEvent::Patch(PatchEvent {
                p: "/message/id".to_string(),
                o: "replace".to_string(),
                v: json!("m1"),
                c: Some(3.0),
            })
        );
    }

    #[test]
    fn non_string_path_or_op_and_non_number_counter_are_ignored() {
        // Upstream guards each with a typeof check, so wrong-typed fields
        // fall back to the inherited values rather than being coerced.
        assert_eq!(
            parse_sse_event(r#"{"p":5,"o":true,"c":"9","v":1}"#, &inherited()),
            StreamEvent::Patch(PatchEvent {
                p: "/message/content/parts/0".to_string(),
                o: "append".to_string(),
                v: json!(1),
                c: None,
            })
        );
    }

    #[test]
    fn an_object_without_type_or_v_is_unknown() {
        assert_eq!(
            parse_sse_event(r#"{"other":1}"#, &inherited()),
            StreamEvent::Unknown(json!({"other":1}))
        );
    }

    #[test]
    fn a_null_v_value_still_produces_a_patch() {
        // `"v" in parsed` is a key-presence check, so an explicit null value
        // is a patch rather than an unknown event.
        assert_eq!(
            parse_sse_event(r#"{"v":null}"#, &inherited()),
            StreamEvent::Patch(PatchEvent {
                p: "/message/content/parts/0".to_string(),
                o: "append".to_string(),
                v: Value::Null,
                c: None,
            })
        );
    }
}
