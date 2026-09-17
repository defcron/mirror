//! The impersonating HTTP client every upstream call goes through.
//!
//! This is the reason the rewrite exists. Node's `fetch`/`undici` presents
//! Node's own TLS stack, whose JA3/JA4 fingerprint is trivially
//! distinguishable from real Chrome no matter how carefully the HTTP headers
//! are spoofed — a limitation the TypeScript implementation documented in
//! `proxy.ts` and could not fix. `wreq` drives a BoringSSL-backed handshake
//! with a per-Chrome-version profile, so the ClientHello, extension
//! ordering, cipher list, ALPN and HTTP/2 SETTINGS all match a real browser.
//!
//! # Note on the crate name
//!
//! The migration plan named `rquest`, which is what dairoot's binary uses.
//! Every published `rquest` version has since been yanked and the project
//! was renamed by its author to `wreq` (same repository owner, `ja3`/`ja4`
//! keywords, ~600k recent downloads). `wreq` is therefore the direct
//! continuation rather than a substitute, and it ships newer Chrome profiles
//! (through Chrome 149) than `rquest` ever did (Chrome 131).
//!
//! # Version consistency
//!
//! The emulated Chrome version, the `User-Agent` and the `sec-ch-ua` hints
//! must all name the same Chrome release. A UA claiming one version over a
//! handshake fingerprinted as another is itself a signal, so all three are
//! derived from [`EMULATED_CHROME`] here rather than hardcoded separately as
//! they were in `proxy.ts` (which advertised Chrome 152 while having no
//! control over its TLS fingerprint at all).

use wreq_util::{Emulation, Profile};

/// The single source of truth for which Chrome release Mirror presents as.
/// Bump this when `wreq-util` gains a newer profile, and the UA and client
/// hints below follow automatically.
pub const EMULATED_CHROME: Profile = Emulation::Chrome149;

/// Major version matching [`EMULATED_CHROME`], used to build the UA and
/// `sec-ch-ua` values so they cannot drift from the TLS profile.
pub const EMULATED_CHROME_MAJOR: u32 = 149;

/// The `User-Agent` Mirror sends upstream.
pub fn user_agent() -> String {
    format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{EMULATED_CHROME_MAJOR}.0.0.0 Safari/537.36"
    )
}

/// The `sec-ch-ua` client hint consistent with [`EMULATED_CHROME`]. Brand
/// order and the GREASE brand spelling match what `proxy.ts` sent, with only
/// the version substituted.
pub fn sec_ch_ua() -> String {
    format!(
        r#""Chromium";v="{EMULATED_CHROME_MAJOR}", "Not?A_Brand";v="24", "Google Chrome";v="{EMULATED_CHROME_MAJOR}""#
    )
}

/// The `sec-ch-ua-platform` fallback, matching the UA's claimed platform.
pub const SEC_CH_UA_PLATFORM: &str = "\"macOS\"";
/// The `sec-ch-ua-mobile` fallback.
pub const SEC_CH_UA_MOBILE: &str = "?0";

/// Builds the shared client. All upstream traffic (proxy forwarding,
/// protocol calls, session minting) must go through one of these so every
/// connection carries the same fingerprint.
pub fn build_client() -> Result<wreq::Client, wreq::Error> {
    wreq::Client::builder().emulation(EMULATED_CHROME).build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_client_builds_with_a_chrome_emulation_profile() {
        // Compile-and-construct check: if wreq's emulation API shape changes
        // under a rolling dependency, this fails here rather than at the
        // first upstream request.
        assert!(build_client().is_ok());
    }

    #[test]
    fn the_user_agent_and_client_hints_name_the_emulated_chrome_version() {
        // The whole point of deriving these: a UA/hint/TLS version mismatch
        // is itself a fingerprint.
        let ua = user_agent();
        let hints = sec_ch_ua();
        let expected = EMULATED_CHROME_MAJOR.to_string();

        assert!(
            ua.contains(&format!("Chrome/{expected}.0.0.0")),
            "UA {ua} should name Chrome {expected}"
        );
        assert!(
            hints.contains(&format!(r#""Google Chrome";v="{expected}""#)),
            "hints {hints} should name Chrome {expected}"
        );
        assert!(
            hints.contains(&format!(r#""Chromium";v="{expected}""#)),
            "hints {hints} should name Chromium {expected}"
        );
    }

    #[test]
    fn the_user_agent_keeps_the_shape_real_chrome_sends() {
        let ua = user_agent();
        assert!(ua.starts_with("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"));
        assert!(ua.contains("AppleWebKit/537.36 (KHTML, like Gecko)"));
        assert!(ua.ends_with("Safari/537.36"));
    }
}
