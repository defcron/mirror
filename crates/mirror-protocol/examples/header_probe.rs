//! Prints the headers wreq's Chrome emulation sends when we override nothing.
//! Run: cargo run -p mirror-protocol --example header_probe
use mirror_protocol::http;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = http::build_client()?;
    let body = client
        .get("https://tls.peet.ws/api/all")
        .send()
        .await?
        .text()
        .await?;
    let parsed: serde_json::Value = serde_json::from_str(&body)?;
    if let Some(headers) = parsed.pointer("/http1/headers").or_else(|| parsed.pointer("/http2/sent_frames")) {
        println!("{}", serde_json::to_string_pretty(headers)?);
    } else {
        println!("{}", serde_json::to_string_pretty(&parsed)?);
    }
    Ok(())
}
