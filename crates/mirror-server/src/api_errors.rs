//! Public errors and diagnostics shape for OpenAI-compatible API endpoints.
//! Port of `apps/server/src/api-errors.ts`.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailureRecord {
    pub at: String,
    pub code: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "protocolCategory")]
    pub protocol_category: Option<String>,
}

static RECENT_FAILURES: Mutex<Vec<FailureRecord>> = Mutex::new(Vec::new());

fn error_category(status: u16) -> (&'static str, &'static str, &'static str) {
    match status {
        400 => (
            "invalid_request_error",
            "invalid_request",
            "Invalid request. Check the supported fields and message history.",
        ),
        401 => (
            "authentication_error",
            "authentication_required",
            "Supply a configured Mirror API key and check session readiness.",
        ),
        403 => (
            "permission_error",
            "request_forbidden",
            "Request rejected. Check the browser origin and account permissions.",
        ),
        404 => (
            "invalid_request_error",
            "not_found",
            "The requested resource was not found.",
        ),
        409 => (
            "invalid_request_error",
            "conversation_conflict",
            "Conversation or session changed. Reload before continuing.",
        ),
        428 => (
            "challenge_required_error",
            "challenge_required",
            "ChatGPT requires an interactive challenge. Complete it in ChatGPT before retrying, or supply a fresh request-scoped challenge token.",
        ),
        429 => (
            "rate_limit_error",
            "rate_limit_exceeded",
            "Rate limit reached. Wait before sending another request.",
        ),
        504 => (
            "timeout_error",
            "deadline_exceeded",
            "Generation deadline exceeded. Reload history before retrying; upstream completion is uncertain.",
        ),
        _ => (
            "server_error",
            "upstream_failure",
            "Generation failed. Check WARP and session readiness, then reload history before retrying.",
        ),
    }
}

/// Constructs a standardized OpenAI `/v1` error payload.
pub fn api_error(status: u16, message: &str, request_id: &str) -> Value {
    let (err_type, code, fallback) = error_category(status);
    let msg = if status == 400 { message } else { fallback };
    json!({
        "error": {
            "type": err_type,
            "code": code,
            "message": msg,
            "request_id": request_id,
        }
    })
}

/// Records a failed request in the bounded ring buffer (retains last 20 failures).
pub fn record_failure(code: &str, request_id: &str, protocol_category: Option<&str>) {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut lock = RECENT_FAILURES.lock().expect("recent failures lock");
    lock.push(FailureRecord {
        at: now,
        code: code.to_string(),
        request_id: request_id.to_string(),
        protocol_category: protocol_category.map(str::to_string),
    });
    if lock.len() > 20 {
        lock.remove(0);
    }
}

/// Returns a clone of recent failures.
pub fn recent_failures() -> Vec<FailureRecord> {
    RECENT_FAILURES.lock().expect("recent failures lock").clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_status_400_uses_custom_message() {
        let err = api_error(400, "custom prompt required", "req-123");
        assert_eq!(err["error"]["type"], "invalid_request_error");
        assert_eq!(err["error"]["code"], "invalid_request");
        assert_eq!(err["error"]["message"], "custom prompt required");
        assert_eq!(err["error"]["request_id"], "req-123");
    }

    #[test]
    fn format_status_401_uses_fallback_message() {
        let err = api_error(401, "ignored message", "req-456");
        assert_eq!(err["error"]["type"], "authentication_error");
        assert_eq!(err["error"]["code"], "authentication_required");
        assert_eq!(
            err["error"]["message"],
            "Supply a configured Mirror API key and check session readiness."
        );
        assert_eq!(err["error"]["request_id"], "req-456");
    }

    #[test]
    fn format_status_all_categories() {
        let cases = [
            (403, "permission_error", "request_forbidden"),
            (404, "invalid_request_error", "not_found"),
            (409, "invalid_request_error", "conversation_conflict"),
            (428, "challenge_required_error", "challenge_required"),
            (429, "rate_limit_error", "rate_limit_exceeded"),
            (504, "timeout_error", "deadline_exceeded"),
            (500, "server_error", "upstream_failure"),
            (502, "server_error", "upstream_failure"),
        ];

        for (status, expected_type, expected_code) in cases {
            let err = api_error(status, "msg", "req-test");
            assert_eq!(err["error"]["type"], expected_type);
            assert_eq!(err["error"]["code"], expected_code);
            assert_eq!(err["error"]["request_id"], "req-test");
        }
    }

    #[test]
    fn recent_failures_records_protocol_category() {
        record_failure("test_code", "req_cat", Some("auth-challenge"));
        let list = recent_failures();
        let item = list.iter().find(|r| r.request_id == "req_cat").unwrap();
        assert_eq!(item.code, "test_code");
        assert_eq!(item.protocol_category.as_deref(), Some("auth-challenge"));
    }

    #[test]
    fn recent_failures_ring_buffer_caps_at_twenty() {
        for i in 0..25 {
            record_failure(&format!("code_{i}"), &format!("ring_req_{i}"), None);
        }
        let list = recent_failures();
        assert_eq!(list.len(), 20);
        let my_items: Vec<_> = list
            .iter()
            .filter(|r| r.request_id.starts_with("ring_req_"))
            .collect();
        assert!(!my_items.is_empty());
        assert_eq!(my_items.last().unwrap().code, "code_24");
    }
}
