//! Verifies that outbound requests really do carry a Chrome TLS fingerprint.
//!
//! This is the one claim the whole rewrite rests on, and it cannot be
//! asserted in a unit test because it requires a real TLS handshake with a
//! remote peer that reports back what it saw. Run it by hand:
//!
//! ```sh
//! cargo run -p mirror-protocol --example fingerprint_check
//! ```
//!
//! It makes a single request to a public TLS-fingerprint echo service and
//! prints the JA3/JA4 hashes and the peer's view of the ALPN/cipher order.
//! Compare the JA4 against a real Chrome of the emulated major version; a
//! generic Rust/Node client produces a visibly different one.
//!
//! Deliberately an example rather than a test: `cargo test` must stay
//! hermetic and offline.

use mirror_protocol::http;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = http::build_client()?;

    // Identity headers come from the emulation profile, not from us — see
    // examples/header_probe.rs to print the ones it actually sends.
    println!("emulating Chrome {}\n", http::EMULATED_CHROME_MAJOR);

    let response = client
        .get("https://tls.peet.ws/api/all")
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;
    println!("status: {status}");

    // Pull just the fingerprint-relevant fields out rather than dumping the
    // whole payload.
    match serde_json::from_str::<serde_json::Value>(&body) {
        Ok(parsed) => {
            let tls = parsed.get("tls");
            for (label, pointer) in [
                ("ja3", "/tls/ja3"),
                ("ja3_hash", "/tls/ja3_hash"),
                ("ja4", "/tls/ja4"),
                ("peetprint_hash", "/tls/peetprint_hash"),
                ("http_version", "/http_version"),
            ] {
                if let Some(value) = parsed.pointer(pointer) {
                    println!("{label}: {value}");
                }
            }
            if let Some(alpn) = tls.and_then(|t| t.get("client_hello_alpn")) {
                println!("alpn: {alpn}");
            }
            if let Some(h2) = parsed.pointer("/http2/akamai_fingerprint_hash") {
                println!("akamai_h2_hash: {h2}");
            }
        }
        Err(_) => println!("unparsed body:\n{body}"),
    }

    Ok(())
}
