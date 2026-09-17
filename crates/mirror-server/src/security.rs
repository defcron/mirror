//! Origin/Host allow-listing, API-key parsing, bearer/cookie auth and the
//! browser bootstrap-cookie gate — a faithful port of
//! `apps/server/src/security.ts`.
//!
//! This is the most security-critical module in the app: every request passes
//! through `authorized_local_request` (or is waved past it by
//! `may_bootstrap_browser`), and `is_allowed_request_host` is the
//! DNS-rebinding guard that keeps a loopback-bound Mirror from being driven
//! by an attacker-controlled hostname.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use std::sync::LazyLock;
use subtle::ConstantTimeEq;
use url::Url;

/// Mirrors `hostnameFromHost`: parse `host` as the authority of a URL and
/// return its hostname, lowercased with any IPv6 brackets stripped.
/// Returns `None` when the authority is unparseable, matching the TS version's
/// `catch { return null }`.
pub fn hostname_from_host(host: &str) -> Option<String> {
    let parsed = Url::parse(&format!("http://{host}")).ok()?;
    let hostname = parsed.host_str()?;
    Some(
        hostname
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase(),
    )
}

/// Mirrors `configuredApiKeys`: merge `MIRROR_API_KEY`, the comma-separated
/// `MIRROR_API_KEYS`, and `OPENAI_API_KEY`, trimming each and dropping empties.
pub fn configured_api_keys_from(
    mirror_api_key: Option<&str>,
    mirror_api_keys: Option<&str>,
    openai_api_key: Option<&str>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut push = |value: &str| {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            out.push(trimmed.to_string());
        }
    };
    if let Some(v) = mirror_api_key {
        push(v);
    }
    for part in mirror_api_keys.unwrap_or("").split(',') {
        push(part);
    }
    if let Some(v) = openai_api_key {
        push(v);
    }
    out
}

pub fn configured_api_keys() -> Vec<String> {
    configured_api_keys_from(
        std::env::var("MIRROR_API_KEY").ok().as_deref(),
        std::env::var("MIRROR_API_KEYS").ok().as_deref(),
        std::env::var("OPENAI_API_KEY").ok().as_deref(),
    )
}

/// Mirrors `isLoopbackHostname`.
pub fn is_loopback_hostname(hostname: &str) -> bool {
    let normalized = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized == "::1"
        || (normalized.parse::<std::net::Ipv4Addr>().is_ok() && normalized.starts_with("127."))
}

/// Mirrors `extraAllowedHostnames` — the documented DEMO-ONLY escape hatch.
fn extra_allowed_hostnames(allowed_hosts: Option<&str>) -> Vec<String> {
    allowed_hosts
        .unwrap_or("")
        .split(',')
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect()
}

/// Mirrors `isAllowedRequestHost`. This is the DNS-rebinding guard.
pub fn is_allowed_request_host_with(host: Option<&str>, allowed_hosts: Option<&str>) -> bool {
    let Some(host) = host else { return false };
    let Some(hostname) = hostname_from_host(host) else {
        return false;
    };
    if is_loopback_hostname(&hostname) {
        return true;
    }
    extra_allowed_hostnames(allowed_hosts).contains(&hostname)
}

pub fn is_allowed_request_host(host: Option<&str>) -> bool {
    is_allowed_request_host_with(host, std::env::var("MIRROR_ALLOWED_HOSTS").ok().as_deref())
}

/// Mirrors `isAllowedOrigin`. An absent Origin is allowed (non-browser
/// clients do not send one); otherwise it must match the request's own host
/// origin, or the configured development web origin.
pub fn is_allowed_origin_with(
    origin: Option<&str>,
    request_host: Option<&str>,
    web_origin: Option<&str>,
) -> bool {
    let Some(origin) = origin else { return true };
    let Ok(origin_url) = Url::parse(origin) else {
        return false;
    };

    if let Some(host) = request_host
        && let Ok(host_url) = Url::parse(&format!("http://{host}"))
        && origin_url.origin() == host_url.origin()
    {
        return true;
    }

    let development_origin = web_origin
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("http://localhost:5173");
    match Url::parse(development_origin) {
        Ok(dev) => origin_url.origin() == dev.origin(),
        Err(_) => false,
    }
}

pub fn is_allowed_origin(origin: Option<&str>, request_host: Option<&str>) -> bool {
    is_allowed_origin_with(
        origin,
        request_host,
        std::env::var("MIRROR_WEB_ORIGIN").ok().as_deref(),
    )
}

/// Mirrors `tokenMatches`: constant-time comparison, but only among
/// equal-length candidates (the length check short-circuits first, exactly as
/// the TS version does to avoid `timingSafeEqual` throwing).
pub fn token_matches(candidate: &str, accepted: &[String]) -> bool {
    accepted.iter().any(|token| {
        token.len() == candidate.len()
            && bool::from(token.as_bytes().ct_eq(candidate.as_bytes()))
    })
}

/// Mirrors `bearerToken`: `/^Bearer\s+(.+)$/i`, returning "" when absent or
/// not a bearer header.
pub fn bearer_token(authorization: Option<&str>) -> &str {
    let Some(value) = authorization else { return "" };
    let Some(rest) = value.get(..6).and_then(|prefix| {
        prefix
            .eq_ignore_ascii_case("Bearer")
            .then(|| &value[6..])
    }) else {
        return "";
    };
    // `\s+` requires at least one whitespace character, and `(.+)` at least
    // one character after it.
    let trimmed = rest.trim_start();
    if trimmed.len() == rest.len() || trimmed.is_empty() {
        return "";
    }
    trimmed
}

const CONTROL_COOKIE_NAME: &str = "mirror_control";

/// Generated once per process, exactly like the TS module-level
/// `controlSecret` — so restarting Mirror invalidates previously issued
/// control cookies.
static CONTROL_SECRET: LazyLock<String> = LazyLock::new(|| {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
});

pub fn control_cookie() -> String {
    format!(
        "{CONTROL_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
        *CONTROL_SECRET
    )
}

fn control_cookie_value(cookie_header: Option<&str>) -> &str {
    let Some(header) = cookie_header else { return "" };
    let prefix = const_format_prefix();
    header
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(prefix))
        .unwrap_or("")
}

const fn const_format_prefix() -> &'static str {
    "mirror_control="
}

/// Mirrors `authorizedLocalRequest`: a configured API key via
/// `Authorization: Bearer`, or the process's control cookie.
pub fn authorized_local_request_with(
    authorization: Option<&str>,
    cookie: Option<&str>,
    api_keys: &[String],
) -> bool {
    if token_matches(bearer_token(authorization), api_keys) {
        return true;
    }
    let secret = CONTROL_SECRET.clone();
    token_matches(control_cookie_value(cookie), std::slice::from_ref(&secret))
}

pub fn authorized_local_request(authorization: Option<&str>, cookie: Option<&str>) -> bool {
    authorized_local_request_with(authorization, cookie, &configured_api_keys())
}

/// Mirrors `mayBootstrapBrowser`: the narrow gate that lets an
/// unauthenticated first page load receive the control cookie. GET only, one
/// of the known browser page paths, an HTML-accepting request, and not a
/// cross-site navigation.
pub fn may_bootstrap_browser(
    method: &str,
    url: &str,
    accept: Option<&str>,
    sec_fetch_site: Option<&str>,
) -> bool {
    let pathname = url.split('?').next().unwrap_or(url);
    let is_browser_page = pathname == "/"
        || pathname == "/mirror/playground"
        || is_conversation_path(pathname);

    method == "GET"
        && is_browser_page
        && accept.unwrap_or("").contains("text/html")
        && sec_fetch_site != Some("cross-site")
}

/// Mirrors `/^\/c\/[a-z0-9:_-]+$/i` — a `/c/<id>` conversation page path.
fn is_conversation_path(pathname: &str) -> bool {
    let Some(rest) = pathname.strip_prefix("/c/") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn hostname_from_host_strips_port_and_lowercases() {
        assert_eq!(hostname_from_host("LocalHost:8787").as_deref(), Some("localhost"));
        assert_eq!(hostname_from_host("127.0.0.1:8787").as_deref(), Some("127.0.0.1"));
        assert_eq!(hostname_from_host("[::1]:8787").as_deref(), Some("::1"));
        assert_eq!(hostname_from_host("example.com").as_deref(), Some("example.com"));
    }

    #[test]
    fn loopback_hostnames_are_recognized() {
        for host in ["localhost", "LOCALHOST", "app.localhost", "::1", "127.0.0.1", "127.1.2.3"] {
            assert!(is_loopback_hostname(host), "{host} should be loopback");
        }
        for host in ["example.com", "128.0.0.1", "0.0.0.0", "notlocalhost"] {
            assert!(!is_loopback_hostname(host), "{host} should not be loopback");
        }
    }

    #[test]
    fn request_host_allows_loopback_and_rejects_everything_else_by_default() {
        assert!(is_allowed_request_host_with(Some("localhost:8787"), None));
        assert!(is_allowed_request_host_with(Some("127.0.0.1:8787"), None));
        assert!(!is_allowed_request_host_with(Some("evil.example.com"), None));
        // A missing Host header is rejected outright.
        assert!(!is_allowed_request_host_with(None, None));
    }

    #[test]
    fn request_host_honors_the_demo_only_allowlist_escape_hatch() {
        let allowed = Some("demo.example.com, other.example.com");
        assert!(is_allowed_request_host_with(Some("demo.example.com"), allowed));
        assert!(is_allowed_request_host_with(Some("DEMO.example.com:443"), allowed));
        assert!(!is_allowed_request_host_with(Some("nope.example.com"), allowed));
    }

    #[test]
    fn absent_origin_is_allowed_for_non_browser_clients() {
        assert!(is_allowed_origin_with(None, Some("localhost:8787"), None));
    }

    #[test]
    fn origin_must_match_request_host_or_the_dev_web_origin() {
        assert!(is_allowed_origin_with(
            Some("http://localhost:8787"),
            Some("localhost:8787"),
            None
        ));
        // Default dev origin (Vite) is allowed even against another host.
        assert!(is_allowed_origin_with(
            Some("http://localhost:5173"),
            Some("localhost:8787"),
            None
        ));
        // A configured dev origin replaces the default.
        assert!(is_allowed_origin_with(
            Some("http://localhost:4000"),
            Some("localhost:8787"),
            Some("http://localhost:4000")
        ));
        assert!(!is_allowed_origin_with(
            Some("https://evil.example.com"),
            Some("localhost:8787"),
            None
        ));
        // Port mismatch is a different origin.
        assert!(!is_allowed_origin_with(
            Some("http://localhost:9999"),
            Some("localhost:8787"),
            None
        ));
        // Scheme mismatch is a different origin.
        assert!(!is_allowed_origin_with(
            Some("https://localhost:8787"),
            Some("localhost:8787"),
            None
        ));
    }

    #[test]
    fn api_keys_merge_all_three_sources_and_drop_blanks() {
        let merged = configured_api_keys_from(Some(" a "), Some("b, ,c"), Some("d"));
        assert_eq!(merged, keys(&["a", "b", "c", "d"]));
        assert!(configured_api_keys_from(None, None, None).is_empty());
        assert!(configured_api_keys_from(Some("  "), Some(",,"), Some("")).is_empty());
    }

    #[test]
    fn token_matches_requires_exact_equal_length_match() {
        let accepted = keys(&["secret-key"]);
        assert!(token_matches("secret-key", &accepted));
        assert!(!token_matches("secret-ke", &accepted));
        assert!(!token_matches("secret-keyy", &accepted));
        assert!(!token_matches("", &accepted));
        // An empty accepted list never matches, including for an empty
        // candidate -- important because bearer_token returns "" when absent.
        assert!(!token_matches("", &[]));
    }

    #[test]
    fn bearer_token_parses_case_insensitively_and_requires_a_value() {
        assert_eq!(bearer_token(Some("Bearer abc")), "abc");
        assert_eq!(bearer_token(Some("bearer abc")), "abc");
        assert_eq!(bearer_token(Some("BEARER   abc")), "abc");
        assert_eq!(bearer_token(None), "");
        assert_eq!(bearer_token(Some("Basic abc")), "");
        // Requires whitespace after the scheme and a non-empty value.
        assert_eq!(bearer_token(Some("Bearerabc")), "");
        assert_eq!(bearer_token(Some("Bearer ")), "");
        assert_eq!(bearer_token(Some("Bearer")), "");
    }

    #[test]
    fn control_cookie_has_the_exact_expected_attributes() {
        let cookie = control_cookie();
        assert!(cookie.starts_with("mirror_control="));
        assert!(cookie.ends_with("; Path=/; HttpOnly; SameSite=Strict"));
        // No Secure attribute: Mirror is served over plain HTTP on loopback.
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn authorized_local_request_accepts_a_configured_api_key() {
        let api_keys = keys(&["k1"]);
        assert!(authorized_local_request_with(Some("Bearer k1"), None, &api_keys));
        assert!(!authorized_local_request_with(Some("Bearer wrong"), None, &api_keys));
    }

    #[test]
    fn authorized_local_request_accepts_the_process_control_cookie() {
        let cookie = control_cookie();
        let value = cookie.split(';').next().unwrap();
        assert!(authorized_local_request_with(None, Some(value), &[]));
        // Alongside other cookies, in any position.
        let mixed = format!("oai-did=abc; {value}; other=1");
        assert!(authorized_local_request_with(None, Some(&mixed), &[]));
    }

    #[test]
    fn authorized_local_request_rejects_an_unknown_or_stale_control_cookie() {
        assert!(!authorized_local_request_with(None, Some("mirror_control=stale"), &[]));
        assert!(!authorized_local_request_with(None, Some("unrelated=1"), &[]));
        assert!(!authorized_local_request_with(None, None, &[]));
    }

    #[test]
    fn browser_bootstrap_allows_exactly_the_known_page_paths() {
        let html = Some("text/html,application/xhtml+xml");
        for path in ["/", "/mirror/playground", "/c/abc123", "/c/6aabc316-e4b8-83e9"] {
            assert!(
                may_bootstrap_browser("GET", path, html, Some("none")),
                "{path} should bootstrap"
            );
        }
        for path in ["/api/health", "/backend-api/me", "/c/", "/c/bad!char", "/other"] {
            assert!(
                !may_bootstrap_browser("GET", path, html, Some("none")),
                "{path} should not bootstrap"
            );
        }
    }

    #[test]
    fn browser_bootstrap_requires_get_html_and_a_non_cross_site_navigation() {
        let html = Some("text/html");
        assert!(may_bootstrap_browser("GET", "/", html, None));
        assert!(may_bootstrap_browser("GET", "/", html, Some("same-origin")));
        // This is the check that made automated navigation fail earlier: an
        // extension/CDP-driven navigation reports cross-site and is refused.
        assert!(!may_bootstrap_browser("GET", "/", html, Some("cross-site")));
        assert!(!may_bootstrap_browser("POST", "/", html, None));
        assert!(!may_bootstrap_browser("GET", "/", Some("application/json"), None));
        assert!(!may_bootstrap_browser("GET", "/", None, None));
    }

    #[test]
    fn browser_bootstrap_ignores_the_query_string_when_matching_paths() {
        let html = Some("text/html");
        assert!(may_bootstrap_browser("GET", "/?foo=bar", html, None));
        assert!(may_bootstrap_browser("GET", "/c/abc?x=1", html, None));
    }
}
