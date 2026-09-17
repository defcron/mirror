//! ChatGPT Web "sentinel" proof-of-work solver — a byte-exact port of
//! `packages/protocol/src/proof.ts`.
//!
//! The server presents a `seed` + `difficulty` (hex string) via
//! POST /backend-api/sentinel/chat-requirements/prepare. The client must find
//! an `attempt` integer such that
//! `sha3_512(seed + base64(json(config_with_attempt)))` has a hex prefix
//! lexicographically <= `difficulty`. The winning token is
//! `"gAAAAAB" + base64(config)`.
//!
//! Parity notes (each of these silently breaks the handshake if got wrong):
//! - `js-sha3`'s `sha3_512` is FIPS-202 SHA3-512, *not* Keccak-512, so this
//!   uses `sha3::Sha3_512` and not `sha3::Keccak512`.
//! - The base64 here is standard *padded* base64 (`Buffer#toString("base64")`),
//!   unlike the base64url used by the store's encryption format.
//! - The difficulty comparison is a raw byte-wise string compare, matching
//!   JS's UTF-16 code-unit compare on lowercase-hex digests. The upstream
//!   validation regex is case-*insensitive*, so an uppercase difficulty is
//!   accepted and then compares differently (ASCII uppercase sorts below
//!   lowercase). That asymmetry is preserved deliberately rather than
//!   normalized, to match upstream exactly.
//! - `JSON.stringify` emits compact JSON with no spaces and leaves non-ASCII
//!   (notably the U+2212 MINUS SIGN in "plugins−[object PluginArray]")
//!   unescaped; `serde_json::to_string` matches on both counts.
//!
//! The TS version runs this in a `worker_threads` worker to keep CPU-bound
//! hashing off Node's single event loop. Rust needs no equivalent ceremony:
//! callers run `generate_proof_token` inside `tokio::task::spawn_blocking`.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use rand::seq::SliceRandom;
use serde_json::{Value, json};
use sha3::{Digest, Sha3_512};

const SCREEN_BASES: [i64; 3] = [3008, 4010, 6000];
const SCREEN_MULTS: [i64; 3] = [1, 2, 4];
const REACT_PROPS: [&str; 3] = [
    "_reactListeningcfilawjnerp",
    "_reactListening9ne2dfo1i47",
    "_reactListening410nzwhan2a",
];
const DOM_EVENTS: [&str; 3] = ["alert", "ontransitionend", "onprogress"];

const FALLBACK_TOKEN_PREFIX: &str = "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D";
const TOKEN_PREFIX: &str = "gAAAAAB";
const MARKER: &str = "gAAAAAB";

pub const DEFAULT_MAX_ATTEMPTS: u64 = 100_000;

#[derive(Debug, thiserror::Error)]
pub enum ProofError {
    #[error("Invalid required proof-of-work challenge")]
    InvalidChallenge,
}

/// The 13-element heterogeneous config array. Held as `Vec<Value>` so its
/// JSON serialization matches `JSON.stringify` on the original JS array
/// exactly, including element order and compact formatting.
#[derive(Debug, Clone)]
pub struct ProofConfig(Vec<Value>);

impl ProofConfig {
    /// Mirrors `defaultProofConfig(userAgent)`.
    pub fn generate(user_agent: Option<&str>) -> Self {
        let mut rng = rand::thread_rng();
        let screen = SCREEN_BASES.choose(&mut rng).copied().unwrap_or(3008)
            * SCREEN_MULTS.choose(&mut rng).copied().unwrap_or(1);
        // `Date#toUTCString()` renders as "%a, %d %b %Y %H:%M:%S GMT" with a
        // zero-padded day, which chrono reproduces with this exact format.
        let parse_time = chrono::Utc::now()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string();
        Self(vec![
            json!(screen),
            json!(parse_time),
            Value::Null,
            json!(0),
            match user_agent {
                Some(ua) => json!(ua),
                None => Value::Null,
            },
            json!("https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js"),
            json!("dpl=1440a687921de39ff5ee56b92807faaadce73f13"),
            json!("en"),
            json!("en-US"),
            Value::Null,
            json!("plugins−[object PluginArray]"),
            json!(REACT_PROPS.choose(&mut rng).copied().unwrap_or(REACT_PROPS[0])),
            json!(DOM_EVENTS.choose(&mut rng).copied().unwrap_or(DOM_EVENTS[0])),
        ])
    }

    /// Wrap a server-supplied config array verbatim (from `decode_proof_config`).
    pub fn from_values(values: Vec<Value>) -> Self {
        Self(values)
    }

    fn set_attempt(&mut self, attempt: u64) {
        if self.0.len() > 3 {
            self.0[3] = json!(attempt);
        }
    }

    fn to_base64(&self) -> String {
        BASE64_STANDARD.encode(
            serde_json::to_string(&self.0)
                .expect("a Vec<Value> always serializes")
                .as_bytes(),
        )
    }
}

/// Mirrors `decodeProofConfig`. Returns `None` when the hint is absent or
/// unparseable; callers fall back to a freshly generated config.
pub fn decode_proof_config(proof_header: Option<&str>) -> Option<Vec<Value>> {
    let header = proof_header?;
    if !header.contains(MARKER) {
        return None;
    }
    // JS `split(sep, 2)` splits on *every* occurrence then truncates the
    // resulting array to 2, so index 1 is the text between the first and
    // second marker — NOT the whole remainder as Rust's `splitn(2, ..)`
    // would give. Replicated with `split(..).nth(1)`.
    let after_marker = header.split(MARKER).nth(1)?;
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
        Value::Array(values) => Some(values),
        _ => None,
    }
}

pub struct GenerateProofOptions<'a> {
    pub required: bool,
    pub seed: &'a str,
    pub difficulty: &'a str,
    pub user_agent: Option<&'a str>,
    pub proof_config: Option<ProofConfig>,
    pub max_attempts: u64,
}

impl<'a> GenerateProofOptions<'a> {
    pub fn new(required: bool, seed: &'a str, difficulty: &'a str) -> Self {
        Self {
            required,
            seed,
            difficulty,
            user_agent: None,
            proof_config: None,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
        }
    }
}

fn is_hex(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Solve the challenge, returning the `gAAAAAB...` token to send as
/// `openai-sentinel-proof-token`, or `None` when `required` is false.
///
/// CPU-bound: run under `tokio::task::spawn_blocking` from async contexts.
pub fn generate_proof_token(opts: GenerateProofOptions<'_>) -> Result<Option<String>, ProofError> {
    if !opts.required {
        return Ok(None);
    }
    if opts.seed.is_empty() || !is_hex(opts.difficulty) {
        return Err(ProofError::InvalidChallenge);
    }

    let mut proof = opts
        .proof_config
        .unwrap_or_else(|| ProofConfig::generate(opts.user_agent));
    let difficulty_len = opts.difficulty.len();

    for attempt in 0..opts.max_attempts {
        proof.set_attempt(attempt);
        let proof_base = proof.to_base64();

        let mut hasher = Sha3_512::new();
        hasher.update(opts.seed.as_bytes());
        hasher.update(proof_base.as_bytes());
        let hash_hex = hex_lower(&hasher.finalize());

        if hash_hex.len() >= difficulty_len && &hash_hex[..difficulty_len] <= opts.difficulty {
            return Ok(Some(format!("{TOKEN_PREFIX}{proof_base}")));
        }
    }

    // Matches the reference client's give-up token byte-for-byte, including
    // wrapping the seed in literal double quotes before base64.
    let fallback_base = BASE64_STANDARD.encode(format!("\"{}\"", opts.seed).as_bytes());
    Ok(Some(format!("{FALLBACK_TOKEN_PREFIX}{fallback_base}")))
}

fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_config() -> ProofConfig {
        // A deterministic stand-in for defaultProofConfig's randomized output,
        // so token values are reproducible across languages.
        ProofConfig::from_values(vec![
            json!(3008),
            json!("Tue, 02 Sep 2026 04:00:00 GMT"),
            Value::Null,
            json!(0),
            Value::Null,
            json!("https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js"),
            json!("dpl=1440a687921de39ff5ee56b92807faaadce73f13"),
            json!("en"),
            json!("en-US"),
            Value::Null,
            json!("plugins−[object PluginArray]"),
            json!("_reactListeningcfilawjnerp"),
            json!("alert"),
        ])
    }

    #[test]
    fn returns_none_when_not_required() {
        let opts = GenerateProofOptions::new(false, "", "");
        assert_eq!(generate_proof_token(opts).unwrap(), None);
    }

    #[test]
    fn rejects_empty_seed_or_non_hex_difficulty() {
        assert!(matches!(
            generate_proof_token(GenerateProofOptions::new(true, "", "00")),
            Err(ProofError::InvalidChallenge)
        ));
        assert!(matches!(
            generate_proof_token(GenerateProofOptions::new(true, "seed", "")),
            Err(ProofError::InvalidChallenge)
        ));
        assert!(matches!(
            generate_proof_token(GenerateProofOptions::new(true, "seed", "zz")),
            Err(ProofError::InvalidChallenge)
        ));
    }

    #[test]
    fn an_all_f_difficulty_is_satisfied_on_the_first_attempt() {
        // "ffff" is the maximum hex prefix, so attempt 0 always wins and the
        // token is fully determined by the config — ideal for a parity check.
        let mut opts = GenerateProofOptions::new(true, "test-seed", "ffff");
        opts.proof_config = Some(fixed_config());
        let token = generate_proof_token(opts).unwrap().unwrap();
        assert!(token.starts_with(TOKEN_PREFIX));

        let mut expected_config = fixed_config();
        expected_config.set_attempt(0);
        assert_eq!(token, format!("{TOKEN_PREFIX}{}", expected_config.to_base64()));
    }

    #[test]
    fn falls_back_to_the_reference_give_up_token_when_attempts_are_exhausted() {
        // "0" is effectively unsatisfiable within one attempt, so capping
        // max_attempts at 1 forces the fallback path.
        let mut opts = GenerateProofOptions::new(true, "abc", "0");
        opts.proof_config = Some(fixed_config());
        opts.max_attempts = 1;
        let token = generate_proof_token(opts).unwrap().unwrap();
        assert_eq!(
            token,
            format!(
                "{FALLBACK_TOKEN_PREFIX}{}",
                BASE64_STANDARD.encode("\"abc\"".as_bytes())
            )
        );
    }

    #[test]
    fn config_json_matches_json_stringify_byte_for_byte() {
        // Captured from the real TS implementation via
        // `JSON.stringify(fixedConfig)` in Node. Every proof hash is taken
        // over this exact byte sequence, so any serialization divergence
        // (spacing, non-ASCII escaping, integer formatting) would silently
        // produce tokens upstream rejects.
        const EXPECTED: &str = r#"[3008,"Tue, 02 Sep 2026 04:00:00 GMT",null,0,null,"https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js","dpl=1440a687921de39ff5ee56b92807faaadce73f13","en","en-US",null,"plugins−[object PluginArray]","_reactListeningcfilawjnerp","alert"]"#;
        assert_eq!(serde_json::to_string(&fixed_config().0).unwrap(), EXPECTED);
    }

    #[test]
    fn decode_proof_config_reads_a_marker_framed_array() {
        let payload = serde_json::to_string(&vec![json!(1), json!("two")]).unwrap();
        // Unpadded, as upstream sends it — decode_proof_config re-pads.
        let encoded = BASE64_STANDARD.encode(payload.as_bytes());
        let unpadded = encoded.trim_end_matches('=');
        let header = format!("prefix{MARKER}{unpadded}~trailing");
        assert_eq!(
            decode_proof_config(Some(&header)),
            Some(vec![json!(1), json!("two")])
        );
    }

    #[test]
    fn decode_proof_config_takes_the_text_between_the_first_and_second_marker() {
        // Guards the JS `split(sep, 2)` vs Rust `splitn(2, ..)` difference:
        // with two markers present, the payload is what sits BETWEEN them.
        let payload = serde_json::to_string(&vec![json!("inner")]).unwrap();
        let encoded = BASE64_STANDARD.encode(payload.as_bytes());
        let unpadded = encoded.trim_end_matches('=');
        let header = format!("head{MARKER}{unpadded}{MARKER}tail");
        assert_eq!(
            decode_proof_config(Some(&header)),
            Some(vec![json!("inner")])
        );
    }

    #[test]
    fn decode_proof_config_returns_none_for_absent_or_garbage_input() {
        assert_eq!(decode_proof_config(None), None);
        assert_eq!(decode_proof_config(Some("no marker here")), None);
        assert_eq!(decode_proof_config(Some(&format!("{MARKER}!!!not-base64"))), None);
        // Valid base64 that decodes to a JSON object rather than an array.
        let obj = BASE64_STANDARD.encode(b"{\"a\":1}");
        assert_eq!(
            decode_proof_config(Some(&format!("{MARKER}{}", obj.trim_end_matches('=')))),
            None
        );
    }

    /// Tokens captured from the real TS `generateProofToken` in Node, using
    /// the same `fixed_config()` and `maxAttempts: 1000`. These pin the whole
    /// algorithm end to end: SHA3-512 (not Keccak), the seed+proofBase
    /// concatenation order, padded base64, the case-sensitive hex-prefix
    /// comparison, and which attempt index wins.
    #[test]
    fn matches_tokens_produced_by_the_original_node_implementation() {
        const FIXTURES: &[(&str, &str, &str)] = &[
            // (seed, difficulty, expected token)
            (
                "test-seed",
                "ffff",
                "gAAAAABWzMwMDgsIlR1ZSwgMDIgU2VwIDIwMjYgMDQ6MDA6MDAgR01UIixudWxsLDAsbnVsbCwiaHR0cHM6Ly90Y3I5aS5jaGF0Lm9wZW5haS5jb20vdjIvMzU1MzZFMUUtNjVCNC00RDk2LTlEOTctNkFEQjdFRkY4MTQ3L2FwaS5qcyIsImRwbD0xNDQwYTY4NzkyMWRlMzlmZjVlZTU2YjkyODA3ZmFhYWRjZTczZjEzIiwiZW4iLCJlbi1VUyIsbnVsbCwicGx1Z2luc+KIkltvYmplY3QgUGx1Z2luQXJyYXldIiwiX3JlYWN0TGlzdGVuaW5nY2ZpbGF3am5lcnAiLCJhbGVydCJd",
            ),
            // Wins at attempt 6 rather than 0 — exercises the search loop.
            (
                "abc",
                "0",
                "gAAAAABWzMwMDgsIlR1ZSwgMDIgU2VwIDIwMjYgMDQ6MDA6MDAgR01UIixudWxsLDYsbnVsbCwiaHR0cHM6Ly90Y3I5aS5jaGF0Lm9wZW5haS5jb20vdjIvMzU1MzZFMUUtNjVCNC00RDk2LTlEOTctNkFEQjdFRkY4MTQ3L2FwaS5qcyIsImRwbD0xNDQwYTY4NzkyMWRlMzlmZjVlZTU2YjkyODA3ZmFhYWRjZTczZjEzIiwiZW4iLCJlbi1VUyIsbnVsbCwicGx1Z2luc+KIkltvYmplY3QgUGx1Z2luQXJyYXldIiwiX3JlYWN0TGlzdGVuaW5nY2ZpbGF3am5lcnAiLCJhbGVydCJd",
            ),
            // Uppercase difficulty: upstream's validation regex is
            // case-insensitive but its comparison is not, and lowercase-hex
            // digests starting with a digit sort below 'F', so this is
            // satisfied at attempt 0. Preserved rather than normalized.
            (
                "s",
                "FFFF",
                "gAAAAABWzMwMDgsIlR1ZSwgMDIgU2VwIDIwMjYgMDQ6MDA6MDAgR01UIixudWxsLDAsbnVsbCwiaHR0cHM6Ly90Y3I5aS5jaGF0Lm9wZW5haS5jb20vdjIvMzU1MzZFMUUtNjVCNC00RDk2LTlEOTctNkFEQjdFRkY4MTQ3L2FwaS5qcyIsImRwbD0xNDQwYTY4NzkyMWRlMzlmZjVlZTU2YjkyODA3ZmFhYWRjZTczZjEzIiwiZW4iLCJlbi1VUyIsbnVsbCwicGx1Z2luc+KIkltvYmplY3QgUGx1Z2luQXJyYXldIiwiX3JlYWN0TGlzdGVuaW5nY2ZpbGF3am5lcnAiLCJhbGVydCJd",
            ),
            // Two-char difficulty, wins at attempt 7.
            (
                "seed123",
                "0a",
                "gAAAAABWzMwMDgsIlR1ZSwgMDIgU2VwIDIwMjYgMDQ6MDA6MDAgR01UIixudWxsLDcsbnVsbCwiaHR0cHM6Ly90Y3I5aS5jaGF0Lm9wZW5haS5jb20vdjIvMzU1MzZFMUUtNjVCNC00RDk2LTlEOTctNkFEQjdFRkY4MTQ3L2FwaS5qcyIsImRwbD0xNDQwYTY4NzkyMWRlMzlmZjVlZTU2YjkyODA3ZmFhYWRjZTczZjEzIiwiZW4iLCJlbi1VUyIsbnVsbCwicGx1Z2luc+KIkltvYmplY3QgUGx1Z2luQXJyYXldIiwiX3JlYWN0TGlzdGVuaW5nY2ZpbGF3am5lcnAiLCJhbGVydCJd",
            ),
        ];

        for (seed, difficulty, expected) in FIXTURES {
            let mut opts = GenerateProofOptions::new(true, seed, difficulty);
            opts.proof_config = Some(fixed_config());
            opts.max_attempts = 1000;
            let token = generate_proof_token(opts).unwrap().unwrap();
            assert_eq!(
                &token, expected,
                "token mismatch for seed={seed:?} difficulty={difficulty:?}"
            );
        }
    }
}
