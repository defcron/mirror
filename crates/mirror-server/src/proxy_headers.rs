//! Request-header construction for upstream proxying — port of
//! `safeRequestHeaders` in `apps/server/src/proxy.ts`.
//!
//! This is an **allowlist**, not a blocklist: a header the browser sends is
//! forwarded only if it is named exactly or carries a known prefix. Getting
//! this wrong is a two-sided failure — too permissive leaks Mirror's own
//! headers (or the browser's display-only bearer token) upstream, too
//! restrictive drops a header ChatGPT requires and breaks the request. The
//! plan ranks it risk item #4.

use std::collections::BTreeMap;

pub const UPSTREAM: &str = "https://chatgpt.com";
pub const UPSTREAM_HOST: &str = "chatgpt.com";

/// Headers forwarded when named exactly, lowercased for comparison.
///
/// The fetch-metadata entries are forwarded from the *real* requesting
/// browser because they describe that specific request (a navigation vs an
/// XHR vs a subresource), which the emulation profile's navigation defaults
/// would get wrong.
///
/// The `sec-ch-ua` family is deliberately absent: those state the browser's
/// *version*, and the emulation profile emits values matching the TLS
/// handshake. Forwarding the real browser's (Chrome 152 here) over a
/// Chrome 149 handshake would reintroduce exactly the mismatch this rewrite
/// removes.
/// `accept-encoding` is forwarded because Chrome advertises `zstd` and the
/// HTTP client's own default is narrower.
const EXACT_ALLOWLIST: [&str; 15] = [
    "accept",
    "accept-language",
    "baggage",
    "cache-control",
    "content-type",
    "pragma",
    "priority",
    "range",
    "sentry-trace",
    "dnt",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-user",
    "accept-encoding",
];

/// Headers forwarded when they start with one of these prefixes — the
/// ChatGPT/OpenAI-specific families the frontend sets itself.
const PREFIX_ALLOWLIST: [&str; 6] = [
    "chatgpt-",
    "oai-",
    "openai-",
    "x-conduit-",
    "x-oai-",
    "x-openai-",
];

fn is_allowed(name: &str) -> bool {
    EXACT_ALLOWLIST.contains(&name)
        || PREFIX_ALLOWLIST
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// Rewrites a client `Referer` that points at Mirror's own origin back to the
/// upstream origin, preserving the path.
///
/// Mirrors the TS version's protocol/hostname/port assignment rather than
/// setting `.host`, which is what fixed a bug where the proxy's port leaked
/// through as `https://chatgpt.com:8787/`.
pub fn rewrite_referer(client_referer: Option<&str>) -> String {
    let fallback = format!("{UPSTREAM}/");
    let Some(referer) = client_referer else {
        return fallback;
    };
    match url::Url::parse(referer) {
        Ok(mut rewritten) => {
            // Setting each component separately (rather than the whole
            // authority) is what drops the proxy's port.
            let _ = rewritten.set_scheme("https");
            if rewritten.set_host(Some(UPSTREAM_HOST)).is_err() {
                return fallback;
            }
            let _ = rewritten.set_port(None);
            rewritten.to_string()
        }
        Err(_) => fallback,
    }
}

/// Builds the upstream request headers from the client's.
///
/// `client_headers` is the incoming request's headers as (lowercased name,
/// value) pairs; repeated names should already be joined with ", " by the
/// caller, matching the TS version's array handling.
pub fn safe_request_headers<'a, I>(client_headers: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut headers: BTreeMap<String, String> = BTreeMap::new();
    let mut client_referer: Option<String> = None;

    for (raw_name, value) in client_headers {
        let name = raw_name.to_ascii_lowercase();
        // Captured separately: referer is rewritten, never forwarded as-is.
        if name == "referer" {
            client_referer = Some(value.to_string());
            continue;
        }
        if is_allowed(&name) {
            headers.insert(name, value.to_string());
        }
    }

    // Origin and host are always ours, never the client's. `user-agent` and
    // the `sec-ch-ua` family are intentionally NOT set: the emulation
    // profile supplies them so they always agree with the handshake.
    headers.insert("origin".to_string(), UPSTREAM.to_string());
    headers.insert("host".to_string(), UPSTREAM_HOST.to_string());
    headers.insert(
        "referer".to_string(),
        rewrite_referer(client_referer.as_deref()),
    );

    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        safe_request_headers(pairs.iter().map(|(k, v)| (*k, *v)))
    }

    #[test]
    fn every_exactly_allowlisted_header_is_forwarded() {
        for name in EXACT_ALLOWLIST {
            let headers = build(&[(name, "probe-value")]);
            assert_eq!(
                headers.get(name).map(String::as_str),
                Some("probe-value"),
                "{name} should be forwarded"
            );
        }
    }

    #[test]
    fn prefixed_chatgpt_and_openai_headers_are_forwarded() {
        let headers = build(&[
            ("chatgpt-account-id", "acct"),
            ("oai-device-id", "dev"),
            ("openai-sentinel-proof-token", "proof"),
            ("x-conduit-token", "conduit"),
            ("x-oai-is-client-observation", "obs"),
            ("x-openai-target-path", "/backend-api/me"),
        ]);
        for name in [
            "chatgpt-account-id",
            "oai-device-id",
            "openai-sentinel-proof-token",
            "x-conduit-token",
            "x-oai-is-client-observation",
            "x-openai-target-path",
        ] {
            assert!(headers.contains_key(name), "{name} should be forwarded");
        }
    }

    #[test]
    fn the_browsers_display_only_bearer_token_is_never_forwarded() {
        // The client holds an unsigned placeholder JWT; forwarding it would
        // send a token upstream rejects instead of the real minted one. This
        // was the root of a real bug, so it gets an explicit test.
        let headers = build(&[("authorization", "Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.")]);
        assert!(!headers.contains_key("authorization"));
    }

    #[test]
    fn cookies_and_other_sensitive_client_headers_are_not_forwarded() {
        let headers = build(&[
            ("cookie", "mirror_control=secret; other=1"),
            ("x-request-id", "req-1"),
            ("x-forwarded-for", "10.0.0.1"),
            ("via", "1.1 proxy"),
            ("connection", "keep-alive"),
            ("upgrade-insecure-requests", "1"),
        ]);
        for name in [
            "cookie",
            "x-request-id",
            "x-forwarded-for",
            "via",
            "connection",
            "upgrade-insecure-requests",
        ] {
            assert!(!headers.contains_key(name), "{name} must not be forwarded");
        }
    }

    #[test]
    fn a_lookalike_prefix_is_not_forwarded() {
        // "x-oai-" is allowed but "x-oaix" is not; the check is a prefix
        // match, not a fuzzy one.
        let headers = build(&[("x-oaixyz", "v"), ("notchatgpt-thing", "v"), ("oaiother", "v")]);
        assert!(!headers.contains_key("x-oaixyz"));
        assert!(!headers.contains_key("notchatgpt-thing"));
        assert!(!headers.contains_key("oaiother"));
    }

    #[test]
    fn header_names_are_matched_case_insensitively() {
        let headers = build(&[("ACCEPT", "text/html"), ("ChatGPT-Account-Id", "acct")]);
        assert_eq!(headers.get("accept").map(String::as_str), Some("text/html"));
        assert_eq!(
            headers.get("chatgpt-account-id").map(String::as_str),
            Some("acct")
        );
    }

    #[test]
    fn origin_and_host_are_always_ours() {
        // Even when the client supplies its own, these are overridden.
        let headers = build(&[
            ("origin", "http://localhost:8787"),
            ("host", "localhost:8787"),
        ]);
        assert_eq!(headers.get("origin").map(String::as_str), Some(UPSTREAM));
        assert_eq!(headers.get("host").map(String::as_str), Some(UPSTREAM_HOST));
    }

    #[test]
    fn identity_headers_are_left_to_the_emulation_profile() {
        // Neither the client's values nor any of ours may appear here: the
        // emulation profile emits user-agent and the sec-ch-ua family so
        // they always match the TLS handshake. Setting them here would
        // override the profile's correct, version-accurate values.
        let headers = build(&[
            ("user-agent", "curl/8.0"),
            ("sec-ch-ua", r#""Chromium";v="152""#),
            ("sec-ch-ua-mobile", "?0"),
            ("sec-ch-ua-platform", "\"Windows\""),
        ]);
        for name in [
            "user-agent",
            "sec-ch-ua",
            "sec-ch-ua-mobile",
            "sec-ch-ua-platform",
        ] {
            assert!(
                !headers.contains_key(name),
                "{name} must be left to the emulation profile, got {:?}",
                headers.get(name)
            );
        }
    }

    #[test]
    fn per_request_fetch_metadata_is_still_forwarded() {
        // These describe the specific request rather than the browser's
        // identity, and the profile's defaults assume a top-level
        // navigation, which is wrong for an XHR or subresource.
        let headers = build(&[
            ("sec-fetch-dest", "empty"),
            ("sec-fetch-mode", "cors"),
            ("sec-fetch-site", "same-origin"),
            ("accept", "application/json"),
        ]);
        assert_eq!(headers.get("sec-fetch-dest").map(String::as_str), Some("empty"));
        assert_eq!(headers.get("sec-fetch-mode").map(String::as_str), Some("cors"));
        assert_eq!(
            headers.get("sec-fetch-site").map(String::as_str),
            Some("same-origin")
        );
        assert_eq!(
            headers.get("accept").map(String::as_str),
            Some("application/json")
        );
    }

    #[test]
    fn a_referer_pointing_at_the_proxy_is_rewritten_preserving_the_path() {
        // The port must be dropped: assigning the whole authority instead of
        // the parts left "https://chatgpt.com:8787/" behind, which was a
        // real bug in the TS version.
        assert_eq!(
            rewrite_referer(Some("http://localhost:8787/c/6aabc316-e4b8")),
            "https://chatgpt.com/c/6aabc316-e4b8"
        );
        assert_eq!(
            rewrite_referer(Some("http://127.0.0.1:8787/")),
            "https://chatgpt.com/"
        );
        // Query strings survive.
        assert_eq!(
            rewrite_referer(Some("http://localhost:8787/c/x?y=1")),
            "https://chatgpt.com/c/x?y=1"
        );
    }

    #[test]
    fn an_absent_or_unparseable_referer_falls_back_to_the_upstream_root() {
        assert_eq!(rewrite_referer(None), "https://chatgpt.com/");
        assert_eq!(rewrite_referer(Some("not a url")), "https://chatgpt.com/");
        assert_eq!(rewrite_referer(Some("")), "https://chatgpt.com/");
    }

    #[test]
    fn the_referer_is_rewritten_rather_than_forwarded_verbatim() {
        let headers = build(&[("referer", "http://localhost:8787/c/abc")]);
        assert_eq!(
            headers.get("referer").map(String::as_str),
            Some("https://chatgpt.com/c/abc")
        );
    }

    #[test]
    fn the_allowlist_has_no_duplicate_or_uppercase_entries() {
        // A stray uppercase entry would silently never match, since names
        // are lowercased before comparison.
        for name in EXACT_ALLOWLIST {
            assert_eq!(name, name.to_ascii_lowercase(), "{name} must be lowercase");
        }
        for prefix in PREFIX_ALLOWLIST {
            assert_eq!(prefix, prefix.to_ascii_lowercase());
        }
        let mut sorted = EXACT_ALLOWLIST.to_vec();
        sorted.sort_unstable();
        let mut deduped = sorted.clone();
        deduped.dedup();
        assert_eq!(sorted, deduped, "the allowlist must not contain duplicates");
    }
}
