//! Startup preflight classification — a faithful port of
//! `apps/server/src/preflight.ts`.
//!
//! Mirror's startup sequence is: build the app (config parsing, master-key /
//! `MIRROR_STORE_KEY` decoding, database open + migration) -> verify required
//! WARP egress -> bind the HTTP listener. Each phase fails recognizably
//! differently; this turns whichever one threw into one short, actionable
//! line instead of a raw stack trace.
//!
//! Deliberately scoped to what can actually throw during *this* startup path.
//! A missing headless browser (used lazily, only when a live Turnstile
//! challenge needs solving) and an expired ChatGPT session token (only
//! discovered on the first proxied/API request) are real failure modes but
//! neither happens at boot, so neither is claimed here.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupFailureCategory {
    Configuration,
    DatabaseMigration,
    WarpEgress,
    PortInUse,
    Unknown,
}

impl StartupFailureCategory {
    /// The exact strings the TS version interpolates into its stderr line.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Configuration => "configuration",
            Self::DatabaseMigration => "database-migration",
            Self::WarpEgress => "warp-egress",
            Self::PortInUse => "port-in-use",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedStartupFailure {
    pub category: StartupFailureCategory,
    pub message: String,
    pub next_action: String,
}

/// Mirrors `classifyStartupFailure`. The arm order is significant: the
/// OS-level error code is checked before any message matching.
///
/// `code` stands in for Node's `error.code` (e.g. `EADDRINUSE`), which Rust
/// callers supply from `io::Error::kind()`/`raw_os_error()` at the call site.
pub fn classify_startup_failure(message: &str, code: Option<&str>) -> ClassifiedStartupFailure {
    let classified = |category: StartupFailureCategory, next_action: &str| ClassifiedStartupFailure {
        category,
        message: message.to_string(),
        next_action: next_action.to_string(),
    };

    if code == Some("EADDRINUSE") {
        return classified(
            StartupFailureCategory::PortInUse,
            "Another process is already using this port. Stop it, or set PORT (direct run) / MIRROR_PORT (Compose) to a free one.",
        );
    }

    if message.contains("Mirror requires WARP") {
        return classified(
            StartupFailureCategory::WarpEgress,
            "Confirm the bundled WARP container is running and WARP_ACCEPT_TOS=yes is set, then restart. Mirror will not fall back to a direct connection.",
        );
    }

    if message.contains("Unsupported database schema version") || message.contains("database schema")
    {
        return classified(
            StartupFailureCategory::DatabaseMigration,
            "This database was created by a newer Mirror release. Restore a compatible backup or upgrade Mirror - see RELEASE-RECOVERY.md.",
        );
    }

    if message.contains("MIRROR_STORE_KEY") || message.contains("must decode to exactly 32 bytes") {
        return classified(
            StartupFailureCategory::Configuration,
            "Fix MIRROR_STORE_KEY in your environment - it must be 32 bytes, base64 or hex-encoded - or unset it to let Mirror generate one.",
        );
    }

    classified(
        StartupFailureCategory::Unknown,
        "Check the full error above; if it keeps happening, open an issue with this message (it has already been kept free of credentials/tokens).",
    )
}

/// Mirrors `formatStartupFailure` — the exact block Mirror prints to stderr
/// on a failed boot.
pub fn format_startup_failure(message: &str, code: Option<&str>) -> String {
    let ClassifiedStartupFailure {
        category,
        message,
        next_action,
    } = classify_startup_failure(message, code);
    format!(
        "mirror failed to start [{}]: {message}\nNext step: {next_action}",
        category.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bound_port_is_classified_from_the_os_error_code() {
        let result = classify_startup_failure("listen EADDRINUSE: address already in use", Some("EADDRINUSE"));
        assert_eq!(result.category, StartupFailureCategory::PortInUse);
        assert!(result.next_action.contains("MIRROR_PORT"));
    }

    #[test]
    fn the_error_code_takes_precedence_over_message_matching() {
        // A bound port whose message happens to mention WARP must still be
        // classified as port-in-use, matching the TS arm order.
        let result = classify_startup_failure("Mirror requires WARP", Some("EADDRINUSE"));
        assert_eq!(result.category, StartupFailureCategory::PortInUse);
    }

    #[test]
    fn warp_verification_failure_is_recognized() {
        let result = classify_startup_failure(
            "Mirror requires WARP, but WARP egress could not be verified: Cloudflare trace did not report warp=on",
            None,
        );
        assert_eq!(result.category, StartupFailureCategory::WarpEgress);
        assert!(result.next_action.contains("WARP_ACCEPT_TOS=yes"));
    }

    #[test]
    fn schema_version_failures_are_recognized_by_either_phrase() {
        for message in [
            "Unsupported database schema version; use a compatible Mirror release or restore a pre-upgrade backup.",
            "something about the database schema went wrong",
        ] {
            assert_eq!(
                classify_startup_failure(message, None).category,
                StartupFailureCategory::DatabaseMigration
            );
        }
    }

    #[test]
    fn store_key_failures_are_recognized_by_either_phrase() {
        for message in [
            "MIRROR_STORE_KEY must decode to exactly 32 bytes",
            "the value must decode to exactly 32 bytes",
        ] {
            assert_eq!(
                classify_startup_failure(message, None).category,
                StartupFailureCategory::Configuration
            );
        }
    }

    #[test]
    fn warp_is_matched_before_schema_and_store_key() {
        // A WARP message that also mentions a store key stays warp-egress,
        // since the WARP arm comes first.
        let result = classify_startup_failure("Mirror requires WARP and MIRROR_STORE_KEY", None);
        assert_eq!(result.category, StartupFailureCategory::WarpEgress);
    }

    #[test]
    fn anything_unrecognized_falls_through_to_unknown() {
        let result = classify_startup_failure("some deep internal thing broke", None);
        assert_eq!(result.category, StartupFailureCategory::Unknown);
        assert!(result.next_action.contains("open an issue"));
    }

    #[test]
    fn formatted_output_matches_the_exact_upstream_shape() {
        let text = format_startup_failure("Mirror requires WARP, but ...", None);
        assert_eq!(
            text,
            "mirror failed to start [warp-egress]: Mirror requires WARP, but ...\nNext step: Confirm the bundled WARP container is running and WARP_ACCEPT_TOS=yes is set, then restart. Mirror will not fall back to a direct connection."
        );
    }
}
