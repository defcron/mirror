//! Mandatory Cloudflare WARP egress verification — a port of
//! `apps/server/src/egress.ts`.
//!
//! Mirror refuses to run over a direct connection. This verifies WARP using
//! Cloudflare's own documented trace endpoint at startup, and re-checks
//! periodically; on loss the process terminates rather than silently falling
//! back. The trace body also contains an IP and location, neither of which is
//! retained or logged.
//!
//! The HTTP call is abstracted behind [`TraceFetcher`] so the verification
//! logic is testable without network access, and so the real implementation
//! can share the impersonating HTTP client used for upstream calls.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

const CLOUDFLARE_TRACE_URL: &str = "https://www.cloudflare.com/cdn-cgi/trace";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EgressMode {
    Direct,
    Warp,
}

impl EgressMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Warp => "warp",
        }
    }
}

/// Mirrors the `EgressStatus` shape surfaced by `GET /api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressStatus {
    pub mode: EgressMode,
    pub required: bool,
    pub verified: bool,
    #[serde(rename = "checkedAt", skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for EgressStatus {
    fn default() -> Self {
        Self {
            mode: EgressMode::Direct,
            required: true,
            verified: false,
            checked_at: None,
            error: None,
        }
    }
}

/// Mirrors `parseCloudflareTrace`: `key=value` lines, skipping any line
/// without a separator at a positive index (so a leading `=` is ignored, as
/// upstream's `separator <= 0` check does).
pub fn parse_cloudflare_trace(body: &str) -> Vec<(String, String)> {
    body.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter_map(|line| {
            let separator = line.find('=')?;
            if separator == 0 {
                return None;
            }
            Some((
                line[..separator].to_string(),
                line[separator + 1..].to_string(),
            ))
        })
        .collect()
}

fn trace_field<'a>(fields: &'a [(String, String)], key: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

#[derive(Debug, thiserror::Error)]
#[error("Mirror requires WARP, but WARP egress could not be verified: {0}")]
pub struct EgressError(pub String);

/// Fetches the Cloudflare trace body. Implemented over the real HTTP client
/// in production; stubbed in tests.
pub trait TraceFetcher: Send + Sync {
    /// Returns the response body, or an error message describing the failure.
    /// Non-2xx responses must be reported as
    /// `Cloudflare trace returned HTTP <status>` to match upstream.
    fn fetch(&self, url: &str) -> impl Future<Output = Result<String, String>> + Send;
}

/// Tracks the last observed egress status, shared with the health route.
#[derive(Clone, Default)]
pub struct EgressMonitor {
    status: Arc<Mutex<EgressStatus>>,
}

impl EgressMonitor {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mirrors `getEgressStatus` — returns a snapshot copy.
    pub fn status(&self) -> EgressStatus {
        self.status.lock().expect("egress status mutex").clone()
    }

    /// Mirrors `verifyRequiredEgress`: records the outcome either way, and
    /// returns `Err` when WARP could not be confirmed. The caller decides
    /// whether that aborts startup or terminates a running process.
    pub async fn verify<F: TraceFetcher>(&self, fetcher: &F) -> Result<EgressStatus, EgressError> {
        let checked_at = Some(now_iso8601());

        let outcome = match fetcher.fetch(CLOUDFLARE_TRACE_URL).await {
            Ok(body) => {
                let fields = parse_cloudflare_trace(&body);
                if trace_field(&fields, "warp") == Some("on") {
                    Ok(())
                } else {
                    Err("Cloudflare trace did not report warp=on".to_string())
                }
            }
            Err(message) => Err(message),
        };

        match outcome {
            Ok(()) => {
                let status = EgressStatus {
                    mode: EgressMode::Warp,
                    required: true,
                    verified: true,
                    checked_at,
                    error: None,
                };
                *self.status.lock().expect("egress status mutex") = status.clone();
                Ok(status)
            }
            Err(error) => {
                *self.status.lock().expect("egress status mutex") = EgressStatus {
                    mode: EgressMode::Direct,
                    required: true,
                    verified: false,
                    checked_at,
                    error: Some(error.clone()),
                };
                Err(EgressError(error))
            }
        }
    }
}

fn now_iso8601() -> String {
    // Matches `new Date().toISOString()`'s millisecond-precision UTC form.
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubFetcher(Result<String, String>);

    impl TraceFetcher for StubFetcher {
        async fn fetch(&self, _url: &str) -> Result<String, String> {
            self.0.clone()
        }
    }

    fn fields(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn trace_parsing_splits_on_the_first_equals_only() {
        let body = "fl=123\nwarp=on\nsomething=a=b\n";
        assert_eq!(
            parse_cloudflare_trace(body),
            fields(&[("fl", "123"), ("warp", "on"), ("something", "a=b")])
        );
    }

    #[test]
    fn trace_parsing_skips_lines_without_a_usable_separator() {
        // A blank line, a line with no '=', and a line starting with '='
        // (separator index 0) are all skipped, matching `separator <= 0`.
        let body = "\nnoequals\n=leading\nwarp=on";
        assert_eq!(parse_cloudflare_trace(body), fields(&[("warp", "on")]));
    }

    #[test]
    fn trace_parsing_handles_crlf_bodies() {
        assert_eq!(
            parse_cloudflare_trace("warp=on\r\nfl=1\r\n"),
            fields(&[("warp", "on"), ("fl", "1")])
        );
    }

    #[test]
    fn trace_parsing_preserves_an_empty_value() {
        assert_eq!(parse_cloudflare_trace("warp="), fields(&[("warp", "")]));
    }

    #[tokio::test]
    async fn warp_on_verifies_and_records_success() {
        let monitor = EgressMonitor::new();
        let status = monitor
            .verify(&StubFetcher(Ok("fl=1\nwarp=on\n".to_string())))
            .await
            .expect("warp=on should verify");
        assert_eq!(status.mode, EgressMode::Warp);
        assert!(status.verified);
        assert!(status.required);
        assert!(status.error.is_none());
        assert!(status.checked_at.is_some());
        // The shared snapshot the health route reads is updated too.
        assert_eq!(monitor.status(), status);
    }

    #[tokio::test]
    async fn warp_off_fails_with_the_exact_upstream_message() {
        let monitor = EgressMonitor::new();
        let error = monitor
            .verify(&StubFetcher(Ok("warp=off\n".to_string())))
            .await
            .expect_err("warp=off must not verify");
        assert_eq!(
            error.to_string(),
            "Mirror requires WARP, but WARP egress could not be verified: Cloudflare trace did not report warp=on"
        );
        let status = monitor.status();
        assert_eq!(status.mode, EgressMode::Direct);
        assert!(!status.verified);
        assert_eq!(
            status.error.as_deref(),
            Some("Cloudflare trace did not report warp=on")
        );
    }

    #[tokio::test]
    async fn a_missing_warp_field_is_treated_as_not_verified() {
        let monitor = EgressMonitor::new();
        assert!(
            monitor
                .verify(&StubFetcher(Ok("fl=1\nip=1.2.3.4\n".to_string())))
                .await
                .is_err()
        );
        assert!(!monitor.status().verified);
    }

    #[tokio::test]
    async fn a_transport_failure_is_surfaced_and_recorded() {
        let monitor = EgressMonitor::new();
        let error = monitor
            .verify(&StubFetcher(Err(
                "Cloudflare trace returned HTTP 503".to_string()
            )))
            .await
            .expect_err("a failed fetch must not verify");
        assert!(error.to_string().contains("Cloudflare trace returned HTTP 503"));
        assert_eq!(
            monitor.status().error.as_deref(),
            Some("Cloudflare trace returned HTTP 503")
        );
    }

    #[tokio::test]
    async fn a_later_failure_clears_a_previously_verified_status() {
        // The monitor must not latch: losing WARP mid-run has to be visible
        // to the health route, since that is what drives shutdown.
        let monitor = EgressMonitor::new();
        monitor
            .verify(&StubFetcher(Ok("warp=on".to_string())))
            .await
            .unwrap();
        assert!(monitor.status().verified);

        assert!(
            monitor
                .verify(&StubFetcher(Ok("warp=off".to_string())))
                .await
                .is_err()
        );
        assert!(!monitor.status().verified);
        assert_eq!(monitor.status().mode, EgressMode::Direct);
    }

    #[test]
    fn iso_timestamps_use_millisecond_precision_utc() {
        let stamp = now_iso8601();
        assert!(stamp.ends_with('Z'), "{stamp} should end with Z");
        // e.g. 2026-09-17T11:22:33.456Z
        assert_eq!(stamp.len(), 24, "{stamp} should be millisecond precision");
    }
}
