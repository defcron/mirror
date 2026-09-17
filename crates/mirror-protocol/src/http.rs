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
//! Every published `rquest` version has since been yanked and the project was
//! renamed by its author to `wreq` (same repository owner, `ja3`/`ja4`
//! keywords). `wreq` is therefore the direct continuation rather than a
//! substitute, and it ships newer Chrome profiles (through 149) than
//! `rquest` ever did (131).
//!
//! # Identity headers belong to the profile, not to us
//!
//! `user-agent`, `sec-ch-ua`, `sec-ch-ua-mobile` and `sec-ch-ua-platform`
//! are deliberately **not** defined in this crate. The emulation profile
//! emits them, version-correct and consistent with the handshake it performs.
//!
//! That matters more than it appears. Chrome randomizes its GREASE brand per
//! release: 149 sends
//! `"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"`,
//! whereas 152 uses `"Not?A_Brand"` in a different order. Hand-maintaining
//! these means getting brand, order and version right by hand on every bump
//! — and the TypeScript version had already drifted into **four** different
//! User-Agents across four files (`proxy.ts` claimed Chrome 152 while
//! `client.ts`, `session.ts` and `turnstile.ts` all claimed 128), so the same
//! account presented two different browsers to chatgpt.com depending on which
//! code path made the call. Letting the profile own these makes that class of
//! mismatch structurally impossible.
//!
//! Callers must therefore not override them. Per-request **context** headers
//! (`sec-fetch-*`, `accept`) are a different matter and are forwarded from
//! the real browser, because the profile's defaults describe a top-level
//! navigation and would be wrong for an XHR or subresource.

use wreq_util::{Emulation, Profile};

/// The single source of truth for which Chrome release Mirror presents as.
/// Bump this when `wreq-util` ships a newer profile; the identity headers
/// follow automatically because the profile emits them.
pub const EMULATED_CHROME: Profile = Emulation::Chrome149;

/// Major version of [`EMULATED_CHROME`], for assertions and diagnostics.
/// Keep in step with the constant above.
pub const EMULATED_CHROME_MAJOR: u32 = 149;

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
        // Compile-and-construct check: if wreq's emulation API shape shifts
        // under a rolling dependency, this fails here rather than at the
        // first upstream request.
        assert!(build_client().is_ok());
    }

    #[test]
    fn the_emulated_profile_and_its_stated_major_version_agree() {
        // The constant pair is the one thing still maintained by hand, and a
        // mismatch would make diagnostics lie about what we present as.
        // `Profile`'s Debug renders the variant name, e.g. "Chrome149".
        let rendered = format!("{EMULATED_CHROME:?}");
        assert!(
            rendered.contains(&EMULATED_CHROME_MAJOR.to_string()),
            "profile {rendered} should name major version {EMULATED_CHROME_MAJOR}"
        );
    }

    // The identity headers the profile actually emits are asserted against a
    // live handshake by `examples/header_probe.rs` and
    // `examples/fingerprint_check.rs`, which cannot run here because
    // `cargo test` stays offline. They are the authoritative check that the
    // UA, client hints and TLS fingerprint all name the same Chrome.
}
