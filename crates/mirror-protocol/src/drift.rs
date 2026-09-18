//! Private-protocol drift classification (MIR-31, NEXT-STEPS.md section 3).
//! Port of `packages/protocol/src/drift.ts`.
//!
//! ChatGPT's backend-api is unversioned and can change shape without notice —
//! that is Mirror's single biggest ongoing risk. When a call into it fails,
//! this turns the failure into one of four sanitized categories instead of a
//! generic 502, so a real protocol drift is immediately distinguishable from
//! an expired session or a normal upstream hiccup — without ever inspecting
//! or retaining the actual response body.

use crate::types::BackendApiError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtocolDriftCategory {
    AuthenticationChallenge,
    TransportTruncation,
    KnownUpstreamError,
    UnsupportedShape,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassifiedDrift {
    pub category: ProtocolDriftCategory,
    /// A short, sanitized note — never the raw upstream body.
    pub note: String,
}

/// Classifies a failure raised while talking to chatgpt.com/backend-api.
/// Order matters: check the most specific/actionable category first.
pub fn classify_protocol_failure(error: &(dyn std::error::Error + 'static)) -> ClassifiedDrift {
    let message = error.to_string();
    let status = error
        .downcast_ref::<BackendApiError>()
        .and_then(|e| e.status);

    classify_protocol_failure_parts(&message, status)
}

/// Inner classification by error message and optional HTTP status code.
pub fn classify_protocol_failure_parts(message: &str, status: Option<u16>) -> ClassifiedDrift {
    if status == Some(401)
        || status == Some(403)
        || message.contains("turnstile")
        || message.contains("Turnstile")
        || message.contains("challenge")
        || message.contains("Session token")
        || message.contains("session token")
    {
        return ClassifiedDrift {
            category: ProtocolDriftCategory::AuthenticationChallenge,
            note: "The session was rejected or ChatGPT is demanding an interactive challenge Mirror could not satisfy. Reconnect the session or complete the challenge in a real browser.".to_string(),
        };
    }

    if message.contains("stream interrupted") || message.contains("stream returned error_code") {
        return if message.contains("error_code") {
            ClassifiedDrift {
                category: ProtocolDriftCategory::KnownUpstreamError,
                note: "ChatGPT's own stream reported an error_code rather than completing normally - not a Mirror parsing failure.".to_string(),
            }
        } else {
            ClassifiedDrift {
                category: ProtocolDriftCategory::TransportTruncation,
                note: "The connection to ChatGPT closed before the stream reached a terminal event. Treat any partial answer as unconfirmed, not successful.".to_string(),
            }
        };
    }

    if message.starts_with("Unsupported ")
        || message.contains("returned non-object JSON")
        || message.contains("no assistant node was received")
    {
        return ClassifiedDrift {
            category: ProtocolDriftCategory::UnsupportedShape,
            note: "backend-api returned a response shape Mirror's protocol layer doesn't recognize - a likely sign the private protocol changed. Attach a sanitized capture, not the raw payload, when reporting this.".to_string(),
        };
    }

    ClassifiedDrift {
        category: ProtocolDriftCategory::Unknown,
        note: "Not one of the recognized drift categories; treat as an ordinary failure unless it recurs.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_auth_and_turnstile_challenges() {
        let drift = classify_protocol_failure_parts("Turnstile challenge required", None);
        assert_eq!(
            drift.category,
            ProtocolDriftCategory::AuthenticationChallenge
        );

        let drift = classify_protocol_failure_parts("Unauthorized", Some(401));
        assert_eq!(
            drift.category,
            ProtocolDriftCategory::AuthenticationChallenge
        );

        let drift = classify_protocol_failure_parts("Forbidden", Some(403));
        assert_eq!(
            drift.category,
            ProtocolDriftCategory::AuthenticationChallenge
        );
    }

    #[test]
    fn classifies_stream_errors() {
        let drift = classify_protocol_failure_parts("stream returned error_code 500", None);
        assert_eq!(drift.category, ProtocolDriftCategory::KnownUpstreamError);

        let drift = classify_protocol_failure_parts("stream interrupted unexpectedly", None);
        assert_eq!(drift.category, ProtocolDriftCategory::TransportTruncation);
    }

    #[test]
    fn classifies_unsupported_shapes() {
        let drift = classify_protocol_failure_parts("GET /me returned non-object JSON", None);
        assert_eq!(drift.category, ProtocolDriftCategory::UnsupportedShape);

        let drift = classify_protocol_failure_parts("Unsupported event type", None);
        assert_eq!(drift.category, ProtocolDriftCategory::UnsupportedShape);
    }

    #[test]
    fn classifies_generic_failures_as_unknown() {
        let drift = classify_protocol_failure_parts("Network connection reset by peer", None);
        assert_eq!(drift.category, ProtocolDriftCategory::Unknown);
    }
}
