//! Rewrites absolute ChatGPT origins embedded in upstream textual assets so
//! browser code served by Mirror talks back to Mirror instead of bypassing
//! it — a faithful port of `apps/server/src/url-rewrite.ts`.
//!
//! This is deliberately done server-side: window-level monkey patches do not
//! affect Dedicated/Shared/ServiceWorker globals, and modern ChatGPT moves a
//! substantial amount of transport code into workers.
//!
//! # Replicated upstream quirk
//!
//! The TS version builds its first two patterns by interpolating
//! `CHATGPT_WEB_HOSTS` (itself an un-parenthesized alternation) into
//! `https://${...}` / `wss://${...}`. Because `|` has the lowest regex
//! precedence, those parse as
//! `(https://(?:[a-z0-9-]+\.)*chatgpt\.com) | (chat\.openai\.com)` — so the
//! legacy `chat.openai.com` host matches as a *bare* alternative with no
//! scheme attached. Consequences, both verified against the real
//! implementation and preserved here deliberately:
//!
//! - `"bare chat.openai.com here"` → `"bare http://localhost:8787 here"`
//! - `"https://chat.openai.com/x"` → `"https://http://localhost:8787/x"`
//!   (malformed — the scheme is left behind)
//!
//! That second case is a real bug, not an intentional behavior. It is
//! reproduced rather than fixed so this port is behaviorally identical; in
//! practice it is near-unreachable because `chat.openai.com` is the legacy
//! domain and current ChatGPT assets reference `chatgpt.com`. Worth fixing
//! separately, in both implementations, as its own change.
//!
//! Note also that the two *escaped* (JSON `\/\/`) patterns in the TS source
//! DO group their alternation correctly, so they require the scheme and are
//! not affected.

use regex::Regex;
use std::sync::LazyLock;

/// `(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com`
const CHATGPT_WEB_HOSTS: &str = r"(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com";

static HTTPS_HOSTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i)https://{CHATGPT_WEB_HOSTS}")).expect("valid regex")
});
static WSS_HOSTS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!("(?i)wss://{CHATGPT_WEB_HOSTS}")).expect("valid regex")
});
static HTTPS_ESCAPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)https:(?:\\/){2}(?:(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com)")
        .expect("valid regex")
});
static WSS_ESCAPED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)wss:(?:\\/){2}(?:(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com)")
        .expect("valid regex")
});

/// Mirrors `isRewritableContentType`.
pub fn is_rewritable_content_type(content_type: &str) -> bool {
    let type_ = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    (type_.starts_with("text/") && type_ != "text/event-stream")
        || type_ == "application/javascript"
        || type_ == "application/x-javascript"
        || type_ == "application/ecmascript"
        || type_ == "application/json"
        || type_ == "application/manifest+json"
}

/// Mirrors `requestOrigin`.
pub fn request_origin(protocol: &str, host: Option<&str>) -> Option<String> {
    let host = host?;
    let scheme = if protocol == "https" { "https" } else { "http" };
    Some(format!("{scheme}://{host}"))
}

/// Mirrors `rewriteChatGptUrls`. Rewrites both normal and JSON-escaped
/// absolute URLs, touching only the ChatGPT web origin — signed blob/CDN URLs
/// and unrelated external services must remain untouched.
///
/// The four substitutions are applied in the same order as upstream, which
/// matters: the `https://` pass runs first and consumes bare
/// `chat.openai.com` occurrences, so the `wss://` pass never sees them.
pub fn rewrite_chatgpt_urls(input: &str, proxy_origin: &str) -> String {
    // `proxyOrigin.replace(/^http/, "ws")`: http→ws, https→wss.
    let proxy_websocket_origin = match proxy_origin.strip_prefix("http") {
        Some(rest) => format!("ws{rest}"),
        None => proxy_origin.to_string(),
    };
    let escaped_proxy = proxy_origin.replace('/', r"\/");
    let escaped_websocket_proxy = proxy_websocket_origin.replace('/', r"\/");

    // `replace_all` treats `$` in the replacement as a capture reference, so
    // use a closure to substitute the literal text instead.
    let step1 = HTTPS_HOSTS.replace_all(input, |_: &regex::Captures<'_>| proxy_origin.to_string());
    let step2 = WSS_HOSTS.replace_all(&step1, |_: &regex::Captures<'_>| {
        proxy_websocket_origin.clone()
    });
    let step3 = HTTPS_ESCAPED.replace_all(&step2, |_: &regex::Captures<'_>| escaped_proxy.clone());
    let step4 = WSS_ESCAPED.replace_all(&step3, |_: &regex::Captures<'_>| {
        escaped_websocket_proxy.clone()
    });
    step4.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROXY: &str = "http://localhost:8787";

    /// Expected values captured from the real TS implementation
    /// (`apps/server/dist/url-rewrite.js`), not produced by this port.
    #[test]
    fn matches_the_original_implementation_on_every_checked_case() {
        const CASES: &[(&str, &str)] = &[
            (
                "https://chatgpt.com/backend-api/me",
                "http://localhost:8787/backend-api/me",
            ),
            (
                "https://cdn.oaistatic.chatgpt.com/x.js",
                "http://localhost:8787/x.js",
            ),
            ("wss://chatgpt.com/realtime", "ws://localhost:8787/realtime"),
            // Upstream quirk: bare legacy host, no scheme required.
            (
                "bare chat.openai.com here",
                "bare http://localhost:8787 here",
            ),
            // Upstream bug, reproduced: the scheme is left stranded.
            (
                "https://chat.openai.com/x",
                "https://http://localhost:8787/x",
            ),
            (
                r"escaped https:\/\/chatgpt.com\/api",
                r"escaped http:\/\/localhost:8787\/api",
            ),
            (
                r"escaped wss:\/\/chatgpt.com\/rt",
                r"escaped ws:\/\/localhost:8787\/rt",
            ),
            ("HTTPS://CHATGPT.COM/Upper", "http://localhost:8787/Upper"),
            // Must NOT touch lookalike or unrelated hosts.
            ("https://notchatgpt.com/x", "https://notchatgpt.com/x"),
            (
                "https://example.com/chatgpt.com",
                "https://example.com/chatgpt.com",
            ),
        ];

        for (input, expected) in CASES {
            assert_eq!(
                &rewrite_chatgpt_urls(input, PROXY),
                expected,
                "mismatch rewriting {input:?}"
            );
        }
    }

    #[test]
    fn an_https_proxy_origin_produces_a_wss_websocket_origin() {
        assert_eq!(
            rewrite_chatgpt_urls("wss://chatgpt.com/rt", "https://example.test"),
            "wss://example.test/rt"
        );
    }

    #[test]
    fn content_type_rewritability_matches_upstream() {
        for t in [
            "text/html; charset=utf-8",
            "application/javascript",
            "application/json",
            "application/manifest+json",
            "TEXT/CSS",
            "application/ecmascript",
            "application/x-javascript",
        ] {
            assert!(is_rewritable_content_type(t), "{t} should be rewritable");
        }
        // text/event-stream is explicitly excluded: rewriting a live SSE
        // body would corrupt the stream framing.
        for t in ["text/event-stream", "image/png", "application/octet-stream"] {
            assert!(!is_rewritable_content_type(t), "{t} should not be rewritable");
        }
    }

    #[test]
    fn request_origin_matches_upstream() {
        assert_eq!(request_origin("https", Some("a:1")).as_deref(), Some("https://a:1"));
        assert_eq!(request_origin("http", Some("a:1")).as_deref(), Some("http://a:1"));
        // Any non-"https" protocol falls back to http, and a missing host
        // yields None (upstream returns null).
        assert_eq!(request_origin("ftp", Some("a:1")).as_deref(), Some("http://a:1"));
        assert_eq!(request_origin("http", None), None);
    }

    #[test]
    fn a_dollar_sign_in_surrounding_text_is_not_treated_as_a_capture_reference() {
        // Guards the regex-crate-specific footgun of `$` expansion in
        // replacement strings, which has no analogue in the TS version.
        assert_eq!(
            rewrite_chatgpt_urls("$1 https://chatgpt.com/x $name", PROXY),
            "$1 http://localhost:8787/x $name"
        );
    }
}
