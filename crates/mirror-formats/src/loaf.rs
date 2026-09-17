//! Linear Object Archive Format (LoaF) codec.
//! Port of `apps/server/src/loaf.ts`.
//!
//! Format specification:
//! `SHA256(-)=<64-hex-hash> <hex-encoded-gzipped-tar-data>`

use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[derive(Debug, thiserror::Error)]
pub enum LoafError {
    #[error("Malformed LoaF text: header does not match expected SHA256(-)=<hash> <payload> pattern")]
    MalformedHeader,
    #[error("Checksum mismatch: expected {expected}, computed {computed}")]
    ChecksumMismatch { expected: String, computed: String },
    #[error("Invalid hex encoding: {0}")]
    InvalidHex(String),
    #[error("Decompression failed: {0}")]
    DecompressionFailed(String),
    #[error("Tar error: {0}")]
    Tar(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoafEntry {
    pub name: String,
    pub content: Vec<u8>,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoafExtractedEntry {
    pub name: String,
    pub content: Vec<u8>,
    pub is_dir: bool,
}

fn to_hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn from_hex(hex: &str) -> Result<Vec<u8>, LoafError> {
    if hex.len() % 2 != 0 {
        return Err(LoafError::InvalidHex("odd length".into()));
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16)
            .map_err(|e| LoafError::InvalidHex(e.to_string()))?;
        bytes.push(byte);
    }
    Ok(bytes)
}

/// Packs files into a single-line, self-checksummed `.loaf` string.
pub fn pack_loaf(entries: &[LoafEntry]) -> Result<String, LoafError> {
    let mut tar_builder = tar::Builder::new(Vec::new());

    for entry in entries {
        let mut header = tar::Header::new_ustar();
        if entry.is_dir {
            let mut name = entry.name.clone();
            if !name.ends_with('/') {
                name.push('/');
            }
            header.set_size(0);
            header.set_mode(0o755);
            header.set_entry_type(tar::EntryType::Directory);
            tar_builder.append_data(&mut header, name, &[][..])?;
        } else {
            header.set_size(entry.content.len() as u64);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            tar_builder.append_data(&mut header, &entry.name, &entry.content[..])?;
        }
    }

    let tar_bytes = tar_builder.into_inner()?;

    let mut gz_encoder = GzEncoder::new(Vec::new(), Compression::default());
    gz_encoder.write_all(&tar_bytes)?;
    let gzipped = gz_encoder.finish()?;

    let hex_payload = to_hex_lower(&gzipped);

    let mut hasher = Sha256::new();
    hasher.update(hex_payload.as_bytes());
    let hash = to_hex_lower(&hasher.finalize());

    Ok(format!("SHA256(-)={hash} {hex_payload}"))
}

/// Unpacks a `.loaf` archive string into individual extracted files.
pub fn unpack_loaf(text: &str) -> Result<Vec<LoafExtractedEntry>, LoafError> {
    let trimmed = text.trim_end_matches(['\r', '\n']);
    let Some(rest) = trimmed.strip_prefix("SHA256(-)=") else {
        return Err(LoafError::MalformedHeader);
    };

    let mut parts = rest.splitn(2, ' ');
    let expected_hash = parts.next().unwrap_or("");
    let hex_payload = parts.next().unwrap_or("");

    if expected_hash.len() != 64 || !expected_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(LoafError::MalformedHeader);
    }
    if !hex_payload.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(LoafError::MalformedHeader);
    }

    let mut hasher = Sha256::new();
    hasher.update(hex_payload.to_ascii_lowercase().as_bytes());
    let computed_hash = to_hex_lower(&hasher.finalize());

    if !expected_hash.eq_ignore_ascii_case(&computed_hash) {
        return Err(LoafError::ChecksumMismatch {
            expected: expected_hash.to_string(),
            computed: computed_hash,
        });
    }

    let gzipped = from_hex(hex_payload)?;

    let mut decoder = GzDecoder::new(&gzipped[..]);
    let mut tar_bytes = Vec::new();
    decoder
        .read_to_end(&mut tar_bytes)
        .map_err(|e| LoafError::DecompressionFailed(e.to_string()))?;

    let mut archive = tar::Archive::new(&tar_bytes[..]);
    let mut extracted = Vec::new();

    for entry_res in archive.entries()? {
        let mut entry = entry_res?;
        let path = entry.path()?.to_string_lossy().into_owned();
        let is_dir = entry.header().entry_type().is_dir();
        let mut content = Vec::new();
        if !is_dir {
            entry.read_to_end(&mut content)?;
        }
        extracted.push(LoafExtractedEntry {
            name: path,
            content,
            is_dir,
        });
    }

    Ok(extracted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loaf_round_trip() {
        let entries = vec![
            LoafEntry {
                name: "hello.txt".into(),
                content: b"Hello, LoaF world!".to_vec(),
                is_dir: false,
            },
            LoafEntry {
                name: "sub/test.json".into(),
                content: b"{\"test\": true}".to_vec(),
                is_dir: false,
            },
        ];

        let loaf = pack_loaf(&entries).unwrap();
        assert!(loaf.starts_with("SHA256(-)="));

        let extracted = unpack_loaf(&loaf).unwrap();
        assert_eq!(extracted.len(), 2);
        assert_eq!(extracted[0].name, "hello.txt");
        assert_eq!(extracted[0].content, b"Hello, LoaF world!");
        assert_eq!(extracted[1].name, "sub/test.json");
        assert_eq!(extracted[1].content, b"{\"test\": true}");
    }

    #[test]
    fn loaf_rejects_corrupted_hash() {
        let entries = vec![LoafEntry {
            name: "test.txt".into(),
            content: b"abc".to_vec(),
            is_dir: false,
        }];
        let loaf = pack_loaf(&entries).unwrap();
        let hex_payload = loaf.split(' ').nth(1).unwrap();
        let tampered = format!("SHA256(-)=0000000000000000000000000000000000000000000000000000000000000000 {hex_payload}");
        assert!(matches!(
            unpack_loaf(&tampered),
            Err(LoafError::ChecksumMismatch { .. })
        ));
    }
}
