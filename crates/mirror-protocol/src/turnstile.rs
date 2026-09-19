//! Cloudflare Turnstile token resolution and browser-based challenge fallback.
//! Byte-exact port of `packages/protocol/src/turnstile.ts`.
//!
//! Tokens returned here belong only to the current Sentinel finalize call.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::process::{Command, Stdio};

const DEFAULT_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TurnstileChallenge {
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dx: Option<String>,
    #[serde(rename = "frameUrl", skip_serializing_if = "Option::is_none")]
    pub frame_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
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

/// Solves a challenge by launching Chromium and talking to its DevTools socket
/// directly. Credentials travel only in CDP messages, never command arguments.
pub fn solve_turnstile_with_browser(
    opts: &BrowserTurnstileOptions,
) -> Result<Option<String>, String> {
    let origin = opts.origin.as_deref().unwrap_or("https://chatgpt.com");
    let frame = opts
        .frame_url
        .as_deref()
        .unwrap_or("https://chatgpt.com/backend-api/sentinel/frame.html");
    let chrome = chromium_binary();
    let mut child = match Command::new(chrome)
        .args([
            "--headless=new",
            "--remote-debugging-address=127.0.0.1",
            "--remote-debugging-port=9222",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--user-data-dir=/tmp/mirror-turnstile-profile",
        ])
        .args(opts.args.clone().unwrap_or_default())
        .stderr(Stdio::null())
        .stdout(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return Ok(None),
    };
    let timeout = std::time::Duration::from_millis(
        opts.timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .saturating_add(5_000),
    );
    let started = std::time::Instant::now();
    let ws = loop {
        if started.elapsed() >= timeout {
            let _ = child.kill();
            return Ok(None);
        };
        if let Ok(response) = ureq::get("http://127.0.0.1:9222/json").call()
            && let Ok(v) = response.into_string()
            && let Some(url) = serde_json::from_str::<Value>(&v).ok().and_then(|v| {
                v.as_array()?
                    .iter()
                    .find(|target| target.get("type").and_then(Value::as_str) == Some("page"))?
                    .get("webSocketDebuggerUrl")?
                    .as_str()
                    .map(str::to_string)
            })
        {
            break url;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    let result = cdp_turnstile(&ws, origin, frame, opts, timeout);
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn chromium_binary() -> String {
    if let Ok(path) = std::env::var("MIRROR_CHROMIUM_BIN") {
        return path;
    }
    for path in ["/usr/bin/chromium", "/usr/bin/chromium-browser"] {
        if std::path::Path::new(path).is_file() {
            return path.into();
        }
    }
    let root =
        std::env::var("PLAYWRIGHT_BROWSERS_PATH").unwrap_or_else(|_| "/ms-playwright".into());
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            for relative in ["chrome-linux/chrome", "chrome-linux-arm64/chrome"] {
                let path = entry.path().join(relative);
                if path.is_file() {
                    return path.to_string_lossy().into_owned();
                }
            }
        }
    }
    "/usr/bin/chromium".into()
}

fn cdp_turnstile(
    ws: &str,
    origin: &str,
    frame: &str,
    opts: &BrowserTurnstileOptions,
    timeout: std::time::Duration,
) -> Result<Option<String>, String> {
    let (mut socket, _) = tungstenite::connect(ws).map_err(|e| e.to_string())?;
    let mut id = 0u64;
    let mut send = |method: &str, params: Value| -> Result<(), String> {
        id += 1;
        socket
            .send(tungstenite::Message::Text(
                json!({"id":id,"method":method,"params":params}).to_string(),
            ))
            .map_err(|e| e.to_string())
    };
    send("Network.enable", json!({}))?;
    send("Page.enable", json!({}))?;
    if let Some(device) = &opts.device_id {
        send(
            "Network.setExtraHTTPHeaders",
            json!({"headers":{"oai-device-id":device}}),
        )?
    };
    if let Some(token) = &opts.session_token {
        send(
            "Network.setCookie",
            json!({"name":"__Secure-next-auth.session-token","value":token,"url":origin,"httpOnly":true,"secure":true,"sameSite":"Lax"}),
        )?
    };
    send("Page.navigate", json!({"url":frame}))?;
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_mut() {
        stream.set_read_timeout(Some(timeout)).ok();
    }
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        let Ok(msg) = socket.read() else { break };
        let Ok(v) = serde_json::from_str::<Value>(msg.into_text().unwrap_or_default().as_str())
        else {
            continue;
        };
        if let Some(token) = find_token(&v) {
            return Ok(Some(token));
        }
    }
    id += 1;
    let evaluation_id = id;
    socket
        .send(tungstenite::Message::Text(
            json!({"id":evaluation_id,"method":"Runtime.evaluate","params":{"expression":"(()=>{const input=document.querySelector('input[name=cf-turnstile-response]');if(input&&input.value)return input.value;const t=window.turnstile;if(t&&typeof t.getResponse==='function')return String(t.getResponse()||'');return ''})()","returnByValue":true}}).to_string(),
        ))
        .map_err(|e| e.to_string())?;
    if let Ok(message) = socket.read()
        && let Ok(value) = serde_json::from_str::<Value>(&message.into_text().unwrap_or_default())
        && value.get("id").and_then(Value::as_u64) == Some(evaluation_id)
    {
        return Ok(value
            .pointer("/result/result/value")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string));
    }
    Ok(None)
}
fn find_token(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return (!s.is_empty() && s.len() > 20 && s.contains('.')).then(|| s.to_string());
    };
    let o = v.as_object()?;
    for (k, x) in o {
        if (k.eq_ignore_ascii_case("openai-sentinel-turnstile-token") || k == "turnstile")
            && let Some(s) = x.as_str()
        {
            return Some(s.to_string());
        }
        if let Some(t) = find_token(x) {
            return Some(t);
        }
    }
    None
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
pub fn resolve_turnstile_token(
    opts: ResolveTurnstileOptions<'_>,
) -> Result<Option<String>, String> {
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
        assert_eq!(
            decode_turnstile_config(Some("prefixgAAAAABinvalid-base64!~tail")),
            None
        );
        // Valid base64 that is not a JSON array
        let obj = BASE64_STANDARD.encode(b"{\"key\": \"val\"}");
        assert_eq!(
            decode_turnstile_config(Some(&format!(
                "prefixgAAAAAB{}~tail",
                obj.trim_end_matches('=')
            ))),
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
        assert_eq!(
            resolve_turnstile_token(opts).unwrap(),
            Some("override-val".into())
        );
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
        assert_eq!(
            resolve_turnstile_token(opts).unwrap(),
            Some("cred-val".into())
        );
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
        assert_eq!(
            resolve_turnstile_token(opts).unwrap(),
            Some("solved-custom".into())
        );
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
        assert_eq!(
            resolve_turnstile_token(opts).unwrap(),
            Some("browser-token".into())
        );
    }
}
