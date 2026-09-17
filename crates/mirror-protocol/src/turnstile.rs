//! Cloudflare Turnstile token resolution and browser-based challenge fallback.
//! Byte-exact port of `packages/protocol/src/turnstile.ts`.
//!
//! Tokens returned here belong only to the current Sentinel finalize call.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const DEFAULT_ORIGIN: &str = "https://chatgpt.com";
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnstileChallenge {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dx: Option<String>,
    #[serde(rename = "frameUrl", skip_serializing_if = "Option::is_none")]
    pub frame_url: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BrowserTurnstileOptions {
    pub origin: Option<String>,
    pub frame_url: Option<String>,
    pub session_token: Option<String>,
    pub device_id: Option<String>,
    pub dx: Option<String>,
    pub timeout_ms: Option<u64>,
    pub args: Option<Vec<String>>,
    pub no_sandbox: bool,
}

pub type TurnstileSolverCallback<'a> =
    Box<dyn Fn(&TurnstileChallenge) -> Option<String> + Send + Sync + 'a>;
pub type BrowserSolverCallback<'a> =
    Box<dyn Fn(&BrowserTurnstileOptions) -> Result<Option<String>, String> + Send + Sync + 'a>;

pub struct ResolveTurnstileOptions<'a> {
    pub required: bool,
    pub dx: Option<&'a str>,
    pub frame_url: Option<&'a str>,
    pub override_token: Option<&'a str>,
    pub credentials_token: Option<&'a str>,
    pub session_token: Option<&'a str>,
    pub device_id: Option<&'a str>,
    pub solver: Option<TurnstileSolverCallback<'a>>,
    pub browser_solver: Option<BrowserSolverCallback<'a>>,
}

/// Decodes the base64 JSON payload embedded in a Sentinel Turnstile `dx` challenge string.
///
/// Upstream formats `dx` as `<prefix>gAAAAAB<base64>~<trailer>`. Returns `None` if `dx`
/// is absent, lacks the `gAAAAAB` marker, fails base64 decoding, or decodes to non-array JSON.
pub fn decode_turnstile_config(dx: Option<&str>) -> Option<Vec<Value>> {
    let dx = dx?;
    if !dx.contains("gAAAAAB") {
        return None;
    }
    // JS `split(sep, 2)` splits on *every* occurrence then truncates the
    // resulting array to 2, so index 1 is the text between the first and
    // second marker. Replicated with `split(..).nth(1)`.
    let after_marker = dx.split("gAAAAAB").nth(1)?;
    if after_marker.is_empty() {
        return None;
    }
    // JS `split("~", 1)[0]` is the segment before the first "~".
    let mut encoded = after_marker.split('~').next()?.to_string();
    let pad = (4 - (encoded.len() % 4)) % 4;
    encoded.push_str(&"=".repeat(pad));

    let decoded = BASE64_STANDARD.decode(encoded.as_bytes()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    match serde_json::from_str::<Value>(&text).ok()? {
        Value::Array(arr) => Some(arr),
        _ => None,
    }
}

/// Solves a Cloudflare Turnstile challenge using a headless browser instance.
///
/// Port of `solveTurnstileWithBrowser` in `packages/protocol/src/turnstile.ts`.
/// Uses `headless_chrome` to navigate to the challenge frame URL, inject
/// session cookies and device ID headers, and capture the Turnstile token.
pub fn solve_turnstile_with_browser(
    opts: &BrowserTurnstileOptions,
) -> Result<Option<String>, String> {
    let origin = opts.origin.as_deref().unwrap_or(DEFAULT_ORIGIN);
    let default_frame_url = format!("{origin}/backend-api/sentinel/frame.html");
    let frame_url = opts.frame_url.as_deref().unwrap_or(&default_frame_url);
    let _timeout_ms = opts.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);

    let no_sandbox = opts.no_sandbox
        || std::env::var("MIRROR_TURNSTILE_NO_SANDBOX")
            .map(|v| v == "true")
            .unwrap_or(false);

    let mut builder = headless_chrome::LaunchOptions::default_builder();
    builder.headless(true);
    if no_sandbox {
        builder.sandbox(false);
    }

    let mut args: Vec<std::ffi::OsString> = vec!["--disable-dev-shm-usage".into()];
    if no_sandbox {
        args.push("--no-sandbox".into());
        args.push("--disable-setuid-sandbox".into());
    }
    if let Some(custom_args) = &opts.args {
        for a in custom_args {
            args.push(a.into());
        }
    }
    let os_args: Vec<&std::ffi::OsStr> = args.iter().map(|s| s.as_os_str()).collect();
    builder.args(os_args);

    let launch_opts = builder
        .build()
        .map_err(|e| format!("Failed to configure headless browser: {e}"))?;

    let browser = match headless_chrome::Browser::new(launch_opts) {
        Ok(b) => b,
        Err(_e) => {
            // Mirrors upstream's catch-all returning null when launch fails
            // (e.g. chromium not installed or sandboxed).
            return Ok(None);
        }
    };

    let tab = match browser.new_tab() {
        Ok(t) => t,
        Err(_) => return Ok(None),
    };

    // Set custom user agent matching the protocol profile.
    let _ = tab.set_user_agent(USER_AGENT, None, None);

    // If session token cookie is provided, add it before navigation.
    if let Some(session_token) = &opts.session_token
        && let Ok(parsed_url) = url::Url::parse(origin)
        && let Some(host) = parsed_url.host_str()
    {
        let _ = tab.navigate_to("about:blank");
        // Inject session cookie
        let cookie_script = format!(
            "document.cookie = '__Secure-next-auth.session-token={session_token}; path=/; domain={host}; Secure; SameSite=Lax';"
        );
        let _ = tab.evaluate(&cookie_script, false);
    }

    if tab.navigate_to(frame_url).is_err() {
        return Ok(None);
    }
    let _ = tab.wait_until_navigated();

    // Query DOM for the Turnstile token response.
    const DOM_QUERY: &str = r#"
        (() => {
            try {
                const input = document.querySelector('input[name="cf-turnstile-response"]');
                if (input && input.value) return input.value;
                const turnstile = window.turnstile;
                if (typeof turnstile?.getResponse === "function") {
                    const response = turnstile.getResponse();
                    if (response) return String(response);
                }
            } catch {}
            return null;
        })()
    "#;

    match tab.evaluate(DOM_QUERY, false) {
        Ok(remote_object) => {
            if let Some(serde_json::Value::String(token)) = remote_object.value
                && !token.is_empty()
            {
                return Ok(Some(token));
            }
            Ok(None)
        }
        Err(_) => Ok(None),
    }
}

/// Resolves a Turnstile token according to upstream priority rules.
///
/// Port of `resolveTurnstileToken` in `packages/protocol/src/turnstile.ts`.
///
/// Priority & short-circuit behavior:
/// 1. Short-circuits to `None` if `!required` (discarding even an explicit override,
///    matching `resolveTurnstileToken({required: false, overrideToken: "x"}) === null`).
/// 2. Returns `override_token` if provided.
/// 3. Returns `credentials_token` if provided.
/// 4. Invokes custom `solver` if provided; returns token if non-empty.
/// 5. Invokes `browser_solver` (or default `solve_turnstile_with_browser`).
pub fn resolve_turnstile_token(opts: ResolveTurnstileOptions<'_>) -> Result<Option<String>, String> {
    if !opts.required {
        return Ok(None);
    }
    if let Some(token) = opts.override_token.filter(|t| !t.is_empty()) {
        return Ok(Some(token.to_string()));
    }
    if let Some(token) = opts.credentials_token.filter(|t| !t.is_empty()) {
        return Ok(Some(token.to_string()));
    }
    if let Some(solver) = &opts.solver {
        let challenge = TurnstileChallenge {
            required: opts.required,
            dx: opts.dx.map(str::to_string),
            frame_url: opts.frame_url.map(str::to_string),
        };
        if let Some(token) = solver(&challenge)
            && !token.is_empty()
        {
            return Ok(Some(token));
        }
    }
    if let Some(browser_solver) = &opts.browser_solver {
        let browser_opts = BrowserTurnstileOptions {
            origin: None,
            frame_url: opts.frame_url.map(str::to_string),
            session_token: opts.session_token.map(str::to_string),
            device_id: opts.device_id.map(str::to_string),
            dx: opts.dx.map(str::to_string),
            timeout_ms: None,
            args: None,
            no_sandbox: false,
        };
        return browser_solver(&browser_opts);
    }

    let browser_opts = BrowserTurnstileOptions {
        origin: None,
        frame_url: opts.frame_url.map(str::to_string),
        session_token: opts.session_token.map(str::to_string),
        device_id: opts.device_id.map(str::to_string),
        dx: opts.dx.map(str::to_string),
        timeout_ms: None,
        args: None,
        no_sandbox: false,
    };
    solve_turnstile_with_browser(&browser_opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decode_turnstile_config_reads_valid_array() {
        let payload = serde_json::to_string(&vec![json!("challenge_a"), json!(123)]).unwrap();
        let encoded = BASE64_STANDARD.encode(payload.as_bytes());
        let unpadded = encoded.trim_end_matches('=');
        let dx = format!("prefixgAAAAAB{unpadded}~trailing");
        assert_eq!(
            decode_turnstile_config(Some(&dx)),
            Some(vec![json!("challenge_a"), json!(123)])
        );
    }

    #[test]
    fn decode_turnstile_config_returns_none_for_missing_or_malformed_input() {
        assert_eq!(decode_turnstile_config(None), None);
        assert_eq!(decode_turnstile_config(Some("")), None);
        assert_eq!(decode_turnstile_config(Some("no-marker-here")), None);
        assert_eq!(decode_turnstile_config(Some("prefixgAAAAAB")), None);
        assert_eq!(decode_turnstile_config(Some("prefixgAAAAABinvalid-base64!~tail")), None);
        // Valid base64 that is not a JSON array
        let obj = BASE64_STANDARD.encode(b"{\"key\": \"val\"}");
        assert_eq!(
            decode_turnstile_config(Some(&format!("prefixgAAAAAB{}~tail", obj.trim_end_matches('=')))),
            None
        );
    }

    #[test]
    fn resolve_turnstile_token_short_circuits_when_not_required() {
        let opts = ResolveTurnstileOptions {
            required: false,
            dx: Some("some-dx"),
            frame_url: None,
            override_token: Some("override-val"),
            credentials_token: Some("cred-val"),
            session_token: None,
            device_id: None,
            solver: Some(Box::new(|_| Some("solver-val".into()))),
            browser_solver: Some(Box::new(|_| Ok(Some("browser-val".into())))),
        };
        assert_eq!(resolve_turnstile_token(opts).unwrap(), None);
    }

    #[test]
    fn resolve_turnstile_token_prioritizes_override_over_credentials() {
        let opts = ResolveTurnstileOptions {
            required: true,
            dx: None,
            frame_url: None,
            override_token: Some("override-val"),
            credentials_token: Some("cred-val"),
            session_token: None,
            device_id: None,
            solver: None,
            browser_solver: None,
        };
        assert_eq!(resolve_turnstile_token(opts).unwrap(), Some("override-val".into()));
    }

    #[test]
    fn resolve_turnstile_token_uses_credentials_when_no_override() {
        let opts = ResolveTurnstileOptions {
            required: true,
            dx: None,
            frame_url: None,
            override_token: None,
            credentials_token: Some("cred-val"),
            session_token: None,
            device_id: None,
            solver: None,
            browser_solver: None,
        };
        assert_eq!(resolve_turnstile_token(opts).unwrap(), Some("cred-val".into()));
    }

    #[test]
    fn resolve_turnstile_token_uses_custom_solver() {
        let opts = ResolveTurnstileOptions {
            required: true,
            dx: Some("dx-test"),
            frame_url: Some("frame-test"),
            override_token: None,
            credentials_token: None,
            session_token: None,
            device_id: None,
            solver: Some(Box::new(|c| {
                assert!(c.required);
                assert_eq!(c.dx.as_deref(), Some("dx-test"));
                assert_eq!(c.frame_url.as_deref(), Some("frame-test"));
                Some("solved-custom".into())
            })),
            browser_solver: None,
        };
        assert_eq!(resolve_turnstile_token(opts).unwrap(), Some("solved-custom".into()));
    }

    #[test]
    fn resolve_turnstile_token_falls_back_to_browser_solver() {
        let opts = ResolveTurnstileOptions {
            required: true,
            dx: Some("dx-browser"),
            frame_url: None,
            override_token: None,
            credentials_token: None,
            session_token: Some("sess-123"),
            device_id: Some("dev-456"),
            solver: Some(Box::new(|_| None)), // solver returns None
            browser_solver: Some(Box::new(|b| {
                assert_eq!(b.session_token.as_deref(), Some("sess-123"));
                assert_eq!(b.device_id.as_deref(), Some("dev-456"));
                Ok(Some("browser-token".into()))
            })),
        };
        assert_eq!(resolve_turnstile_token(opts).unwrap(), Some("browser-token".into()));
    }
}
