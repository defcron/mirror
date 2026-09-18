//! Response header filtering and body rewriting for proxied upstream
//! responses — port of the response half of `proxyChatGpt` in
//! `apps/server/src/proxy.ts`.

use crate::url_rewrite::{is_rewritable_content_type, rewrite_chatgpt_urls};
use regex::Regex;
use std::sync::LazyLock;

/// A syntactically valid, unsigned, non-secret JWT handed to the browser in
/// place of the real access token. The official client decodes expiry and
/// subject locally but never needs a valid signature; the proxy substitutes
/// the real minted token on every upstream call, so this value never leaves
/// the browser.
pub const BROWSER_TOKEN: &str =
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6Im1pcnJvci11c2VyIn0.";

pub use crate::browser_patch::EARLY_PATCH;

/// Response headers never forwarded to the browser.
///
/// `content-encoding`/`content-length`/`transfer-encoding` are dropped
/// because the body is decoded and often rewritten, so upstream's values no
/// longer describe it. The CSP, HSTS and framing headers are dropped because
/// they are written for chatgpt.com's own origin and would break a
/// loopback-served copy. `set-cookie` is dropped so upstream cookies never
/// land in the browser under Mirror's origin.
const STRIPPED_RESPONSE_HEADERS: [&str; 12] = [
    "alt-svc",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "content-security-policy-report-only",
    "nel",
    "report-to",
    "reporting-endpoints",
    "set-cookie",
    "strict-transport-security",
    "transfer-encoding",
    "x-frame-options",
];

pub fn is_stripped_response_header(name: &str) -> bool {
    STRIPPED_RESPONSE_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

/// Only `<script src="...datadoghq...">` tags are stripped, never inline
/// bodies.
///
/// An earlier upstream version matched any `<script>` whose full text
/// contained "datadog"/"dd_rum". That deleted the app's own
/// client-bootstrap script, whose inline JSON config merely *lists*
/// "datadog" among integration names, breaking the app with "missing
/// client-bootstrap script". The narrow form is load-bearing, so it has a
/// dedicated regression test below.
static DATADOG_SRC_SCRIPT_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*>\s*</script>|<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*/>"#,
    )
    .expect("valid regex")
});

/// `/([$\w]+\.init\(\{applicationId:)/g` — short-circuits the bundled RUM
/// init call without altering the surrounding minified code's structure.
static DATADOG_INIT_CALL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([$\w]+\.init\(\{applicationId:)").expect("valid regex"));

static HEAD_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<head[^>]*>").expect("valid regex"));

/// Mirrors `stripDatadogScripts`.
pub fn strip_datadog_scripts(html: &str) -> String {
    DATADOG_SRC_SCRIPT_TAG.replace_all(html, "").into_owned()
}

/// Mirrors `disableDatadogInit`. Mirror does not initialize vendor
/// telemetry, and proxying users' session activity to a third-party
/// analytics vendor is not wanted regardless.
pub fn disable_datadog_init(text: &str) -> String {
    DATADOG_INIT_CALL
        .replace_all(text, "false&&$1")
        .into_owned()
}

/// Injects the early client patch as the first child of `<head>`, or
/// prepends it when the document has no head tag.
pub fn inject_early_patch(html: &str, early_patch: &str) -> String {
    match HEAD_TAG.find(html) {
        Some(found) => {
            let mut out = String::with_capacity(html.len() + early_patch.len());
            out.push_str(&html[..found.end()]);
            out.push_str(early_patch);
            out.push_str(&html[found.end()..]);
            out
        }
        None => format!("{early_patch}{html}"),
    }
}

/// The full HTML transform, in upstream's order: rewrite origins, strip
/// Datadog script tags, swap the real access token for the browser
/// placeholder, then inject the early patch.
///
/// The order matters: the token swap must happen before injection so the
/// patch script itself is never scanned, and `<head>` injection must be last
/// so the patch is the first child.
pub fn transform_html(
    html: &str,
    proxy_origin: Option<&str>,
    html_access_token: Option<&str>,
    early_patch: &str,
) -> String {
    let mut out = match proxy_origin {
        Some(origin) => rewrite_chatgpt_urls(html, origin),
        None => html.to_string(),
    };
    out = strip_datadog_scripts(&out);
    if let Some(token) = html_access_token
        && !token.is_empty()
    {
        out = out.replace(token, BROWSER_TOKEN);
    }
    inject_early_patch(&out, early_patch)
}

/// The transform for non-HTML rewritable assets (JS/JSON/CSS).
///
/// Rewriting these server-side is what makes worker and module globals reach
/// Mirror: patching `window.fetch` alone cannot affect a
/// Dedicated/Shared/ServiceWorker, which has its own `fetch` and `Request`.
pub fn transform_text_asset(text: &str, proxy_origin: &str) -> String {
    disable_datadog_init(&rewrite_chatgpt_urls(text, proxy_origin))
}

/// Mirrors the cache-control policy.
///
/// Anything Mirror rewrites is forced to `no-store`, overriding upstream:
/// those bytes depend on proxy logic that can change independently of
/// upstream, and upstream ships hashed CDN filenames with effectively
/// immutable caching. Honoring that verbatim previously let a browser keep
/// serving a pre-fix copy of a rewritten chunk for its full max-age.
pub fn cache_control(url: &str, content_type: &str, upstream_value: Option<&str>) -> String {
    let is_static_asset = url.starts_with("/cdn/");
    let is_rewritten_text =
        content_type.contains("text/html") || is_rewritable_content_type(content_type);

    if is_rewritten_text {
        return "no-store".to_string();
    }
    match upstream_value {
        Some(value) => value.to_string(),
        None if is_static_asset => "public, max-age=300".to_string(),
        None => "no-store".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROXY: &str = "http://localhost:8787";

    #[test]
    fn every_stripped_header_is_recognized_case_insensitively() {
        for name in STRIPPED_RESPONSE_HEADERS {
            assert!(is_stripped_response_header(name));
            assert!(is_stripped_response_header(&name.to_ascii_uppercase()));
        }
    }

    #[test]
    fn ordinary_response_headers_are_not_stripped() {
        for name in ["content-type", "location", "date", "etag", "cache-control"] {
            assert!(!is_stripped_response_header(name), "{name} should survive");
        }
    }

    #[test]
    fn datadog_script_tags_are_stripped_in_both_forms() {
        let html = r#"<head><script src="https://www.datadoghq-browser-agent.com/rum.js"></script><script src="https://x.datadoghq.com/a.js"/></head>"#;
        let stripped = strip_datadog_scripts(html);
        assert!(!stripped.contains("datadoghq"), "got: {stripped}");
        assert_eq!(stripped, "<head></head>");
    }

    #[test]
    fn an_inline_script_merely_mentioning_datadog_is_preserved() {
        // The regression that matters: the app's own client-bootstrap script
        // embeds a JSON config listing "datadog" among integration names.
        // An over-broad matcher deleted it and broke the app with "missing
        // client-bootstrap script".
        let html = r#"<script id="client-bootstrap" type="application/json">{"integrations":["datadog","statsig"]}</script>"#;
        assert_eq!(strip_datadog_scripts(html), html);
    }

    #[test]
    fn a_non_datadog_script_src_is_preserved() {
        let html = r#"<script src="https://cdn.oaistatic.com/app.js"></script>"#;
        assert_eq!(strip_datadog_scripts(html), html);
    }

    #[test]
    fn the_datadog_rum_init_call_is_short_circuited() {
        let js = "var x=window.DD_RUM;x.init({applicationId:\"abc\",clientToken:\"t\"});";
        let disabled = disable_datadog_init(js);
        assert!(disabled.contains("false&&x.init({applicationId:"));
        // The surrounding minified structure is otherwise untouched.
        assert!(disabled.ends_with("clientToken:\"t\"});"));
    }

    #[test]
    fn a_dollar_prefixed_minified_identifier_still_matches_the_init_pattern() {
        // [$\w]+ exists precisely because minifiers emit $-prefixed names.
        let js = "$a.init({applicationId:1})";
        assert_eq!(disable_datadog_init(js), "false&&$a.init({applicationId:1})");
    }

    #[test]
    fn an_unrelated_init_call_is_not_touched() {
        let js = "thing.init({other:1})";
        assert_eq!(disable_datadog_init(js), js);
    }

    #[test]
    fn the_early_patch_becomes_the_first_child_of_head() {
        let html = "<html><head><title>x</title></head><body/></html>";
        let out = inject_early_patch(html, "<script>P</script>");
        assert_eq!(
            out,
            "<html><head><script>P</script><title>x</title></head><body/></html>"
        );
    }

    #[test]
    fn the_early_patch_injection_handles_head_with_attributes_and_odd_casing() {
        let html = r#"<HEAD lang="en"><title>x</title></HEAD>"#;
        let out = inject_early_patch(html, "P");
        assert_eq!(out, r#"<HEAD lang="en">P<title>x</title></HEAD>"#);
    }

    #[test]
    fn a_document_without_a_head_gets_the_patch_prepended() {
        assert_eq!(inject_early_patch("<body>x</body>", "P"), "P<body>x</body>");
    }

    #[test]
    fn only_the_first_head_is_injected_into() {
        let html = "<head>a</head><head>b</head>";
        let out = inject_early_patch(html, "P");
        assert_eq!(out, "<head>Pa</head><head>b</head>");
    }

    #[test]
    fn the_html_transform_swaps_the_real_token_for_the_browser_placeholder() {
        let html = "<head></head><script>window.token=\"real-secret-token\"</script>";
        let out = transform_html(html, Some(PROXY), Some("real-secret-token"), "");
        assert!(!out.contains("real-secret-token"), "the real token must not be served");
        assert!(out.contains(BROWSER_TOKEN));
    }

    #[test]
    fn the_html_transform_replaces_every_occurrence_of_the_token() {
        let html = "<head></head>a=\"tok\";b=\"tok\";";
        let out = transform_html(html, None, Some("tok"), "");
        assert_eq!(out.matches(BROWSER_TOKEN).count(), 2);
    }

    #[test]
    fn the_html_transform_is_a_no_op_on_the_token_when_none_is_minted() {
        let html = "<head></head>plain";
        let out = transform_html(html, None, None, "");
        assert!(out.contains("plain"));
        assert!(!out.contains(BROWSER_TOKEN));
        // An empty token must not trigger a degenerate replace-everything.
        let empty = transform_html(html, None, Some(""), "");
        assert!(!empty.contains(BROWSER_TOKEN));
    }

    #[test]
    fn the_html_transform_rewrites_origins_and_injects_in_order() {
        let html = r#"<head></head><a href="https://chatgpt.com/c/1">x</a>"#;
        let out = transform_html(html, Some(PROXY), None, "<script>P</script>");
        assert!(out.starts_with("<head><script>P</script>"));
        assert!(out.contains("http://localhost:8787/c/1"));
        assert!(!out.contains("https://chatgpt.com"));
    }

    #[test]
    fn the_text_asset_transform_rewrites_origins_and_disables_telemetry() {
        let js = r#"fetch("https://chatgpt.com/backend-api/me");d.init({applicationId:"a"})"#;
        let out = transform_text_asset(js, PROXY);
        assert!(out.contains("http://localhost:8787/backend-api/me"));
        assert!(out.contains("false&&d.init({applicationId:"));
    }

    #[test]
    fn rewritten_text_is_always_no_store_even_when_upstream_says_immutable() {
        // The bug this prevents: upstream's immutable caching on a hashed
        // CDN filename let a browser keep serving a pre-fix rewritten chunk.
        for content_type in [
            "text/html; charset=utf-8",
            "application/javascript",
            "application/json",
            "text/css",
        ] {
            assert_eq!(
                cache_control("/cdn/assets/x.js", content_type, Some("public, max-age=31536000, immutable")),
                "no-store",
                "{content_type} is rewritten and must not be cached"
            );
        }
    }

    #[test]
    fn non_rewritten_static_assets_fall_back_to_a_short_public_cache() {
        assert_eq!(
            cache_control("/cdn/assets/logo.png", "image/png", None),
            "public, max-age=300"
        );
        // Upstream's own value wins when present.
        assert_eq!(
            cache_control("/cdn/assets/logo.png", "image/png", Some("max-age=99")),
            "max-age=99"
        );
    }

    #[test]
    fn non_static_non_rewritten_responses_default_to_no_store() {
        // Live API data must not be cached by default: caching the models
        // list or conversation state surfaces as the picker disagreeing with
        // what a message actually routes to.
        assert_eq!(
            cache_control("/backend-api/models", "application/octet-stream", None),
            "no-store"
        );
        assert_eq!(
            cache_control("/backend-api/models", "application/octet-stream", Some("max-age=60")),
            "max-age=60"
        );
    }

    #[test]
    fn an_sse_stream_is_neither_rewritten_nor_force_cached() {
        // text/event-stream is excluded from rewriting, so it must not be
        // classified as rewritten text here either.
        assert_eq!(
            cache_control("/backend-api/f/conversation", "text/event-stream", None),
            "no-store"
        );
    }
}
