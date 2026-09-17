//! AES-256-GCM encryption for values at rest, byte-for-byte compatible with
//! the original TypeScript implementation's on-disk format so existing
//! `.data/mirror.db` / `.data/master.key` files keep opening after the
//! rewrite. See `apps/server/src/store.ts` (`encrypt`/`decrypt`,
//! `loadEncryptionKey`) for the reference implementation this mirrors.
//!
//! Encrypted string format: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`,
//! dot-joined, using unpadded base64url throughout (Node's
//! `Buffer#toString("base64url")` never emits `=` padding, confirmed against
//! the TS source rather than assumed).

use aes_gcm::aead::{Aead, KeyInit, generic_array::GenericArray};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use std::fs;
use std::path::Path;

const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("MIRROR_STORE_KEY must decode to exactly 32 bytes")]
    BadKeyLength,
    #[error("invalid key encoding: {0}")]
    BadKeyEncoding(String),
    #[error("unsupported encrypted value")]
    UnsupportedValue,
    #[error("decryption failed")]
    DecryptionFailed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// A loaded 32-byte AES-256-GCM key, matching `encryptionKey` in `store.ts`.
pub struct EncryptionKey(Vec<u8>);

impl EncryptionKey {
    /// Decode a configured key from either a 64-char hex string or base64,
    /// matching `decodeConfiguredKey` exactly: hex is tried first via the
    /// same `^[a-f\d]{64}$` (case-insensitive) shape check, base64 otherwise.
    pub fn decode_configured(value: &str) -> Result<Self, CryptoError> {
        let looks_like_hex = value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit());
        let bytes = if looks_like_hex {
            hex_decode(value).map_err(|e| CryptoError::BadKeyEncoding(e.to_string()))?
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(|e| CryptoError::BadKeyEncoding(e.to_string()))?
        };
        if bytes.len() != KEY_LEN {
            return Err(CryptoError::BadKeyLength);
        }
        Ok(Self(bytes))
    }

    /// Load the key the same way `loadEncryptionKey` does: prefer
    /// `MIRROR_STORE_KEY`, else read-or-generate `<data_dir>/master.key`
    /// (base64, chmod 0600 like the TS version).
    pub fn load(data_dir: &Path) -> Result<Self, CryptoError> {
        if let Ok(configured) = std::env::var("MIRROR_STORE_KEY")
            && !configured.is_empty()
        {
            return Self::decode_configured(&configured);
        }

        let key_file = data_dir.join("master.key");
        if key_file.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&key_file, fs::Permissions::from_mode(0o600))?;
            }
            let contents = fs::read_to_string(&key_file)?;
            return Self::decode_configured(contents.trim());
        }

        let mut key = vec![0u8; KEY_LEN];
        rand::thread_rng().fill_bytes(&mut key);
        let encoded = base64::engine::general_purpose::STANDARD.encode(&key);
        fs::write(&key_file, &encoded)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&key_file, fs::Permissions::from_mode(0o600))?;
        }
        Ok(Self(key))
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(GenericArray::from_slice(&self.0))
    }

    /// Matches `encrypt(value)` in store.ts exactly.
    pub fn encrypt(&self, plaintext: &str) -> String {
        let mut iv = [0u8; IV_LEN];
        rand::thread_rng().fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        // aes-gcm appends the 16-byte tag to the ciphertext, matching
        // Node's default authTagLength of 16 bytes; split it back out below
        // to reproduce the three-part wire format.
        let sealed = self
            .cipher()
            .encrypt(nonce, plaintext.as_bytes())
            .expect("AES-256-GCM encryption cannot fail for in-memory buffers");
        let (ciphertext, tag) = sealed.split_at(sealed.len() - 16);

        [
            "v1".to_string(),
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(tag),
            URL_SAFE_NO_PAD.encode(ciphertext),
        ]
        .join(".")
    }

    /// Matches `decrypt(value)` in store.ts exactly.
    pub fn decrypt(&self, value: &str) -> Result<String, CryptoError> {
        let parts: Vec<&str> = value.split('.').collect();
        let [version, iv, tag, ciphertext] = parts.as_slice() else {
            return Err(CryptoError::UnsupportedValue);
        };
        if *version != "v1" || iv.is_empty() || tag.is_empty() || ciphertext.is_empty() {
            return Err(CryptoError::UnsupportedValue);
        }

        let iv_bytes = URL_SAFE_NO_PAD
            .decode(iv)
            .map_err(|_| CryptoError::UnsupportedValue)?;
        let tag_bytes = URL_SAFE_NO_PAD
            .decode(tag)
            .map_err(|_| CryptoError::UnsupportedValue)?;
        let ciphertext_bytes = URL_SAFE_NO_PAD
            .decode(ciphertext)
            .map_err(|_| CryptoError::UnsupportedValue)?;

        let mut sealed = ciphertext_bytes;
        sealed.extend_from_slice(&tag_bytes);

        let nonce = Nonce::from_slice(&iv_bytes);
        let plaintext = self
            .cipher()
            .decrypt(nonce, sealed.as_ref())
            .map_err(|_| CryptoError::DecryptionFailed)?;
        String::from_utf8(plaintext).map_err(|_| CryptoError::DecryptionFailed)
    }
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err("odd-length hex string".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> EncryptionKey {
        EncryptionKey(vec![7u8; KEY_LEN])
    }

    #[test]
    fn round_trips_plain_ascii() {
        let k = key();
        let ct = k.encrypt("hello world");
        assert_eq!(k.decrypt(&ct).unwrap(), "hello world");
    }

    #[test]
    fn empty_plaintext_encrypts_to_undecryptable_value_matching_upstream_quirk() {
        // Encrypting "" produces a zero-length ciphertext segment, so the
        // encrypted string ends in a trailing dot (`v1.<iv>.<tag>.`). The
        // original TS `decrypt()` checks `!ciphertext`, and an empty string
        // is falsy in JS, so upstream's own decrypt() rejects this exact
        // case with "Unsupported encrypted value" too - this is a faithful
        // port of that pre-existing quirk, not a bug introduced here. In
        // practice the only encrypted field (`settings.session`) is never
        // an empty string, so this never fires for real data.
        let k = key();
        let ct = k.encrypt("");
        assert!(matches!(k.decrypt(&ct), Err(CryptoError::UnsupportedValue)));
    }

    #[test]
    fn round_trips_unicode() {
        let k = key();
        let ct = k.encrypt("héllo 世界 🚀");
        assert_eq!(k.decrypt(&ct).unwrap(), "héllo 世界 🚀");
    }

    #[test]
    fn format_has_v1_prefix_and_four_dot_separated_parts() {
        let k = key();
        let ct = k.encrypt("x");
        let parts: Vec<&str> = ct.split('.').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v1");
        // base64url must never contain padding or the standard-alphabet
        // '+'/'/' characters, matching Node's base64url encoding.
        for part in &parts[1..] {
            assert!(!part.contains('='));
            assert!(!part.contains('+'));
            assert!(!part.contains('/'));
        }
    }

    #[test]
    fn rejects_wrong_version() {
        let k = key();
        let ct = k.encrypt("x").replacen("v1", "v2", 1);
        assert!(matches!(k.decrypt(&ct), Err(CryptoError::UnsupportedValue)));
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let k = key();
        let mut ct = k.encrypt("secret");
        ct.push('x');
        assert!(k.decrypt(&ct).is_err());
    }

    #[test]
    fn decrypts_a_fixture_produced_by_the_original_node_implementation() {
        // Generated with Node's actual `node:crypto` APIs (createCipheriv,
        // the same call `store.ts` makes), not by this Rust code - proves
        // genuine cross-language wire-format compatibility rather than mere
        // internal self-consistency. Key is 32 bytes of 0x07, IV is 12 bytes
        // of 0x03 (fixed for reproducibility).
        let k = EncryptionKey(vec![7u8; KEY_LEN]);
        let fixture = "v1.AwMDAwMDAwMDAwMD.lFTveRVBSjR3HvCcmU8wXw.RozMcCkFMiMUJzY9jDLffIxOiZvNtfcYSr3si8ONgxHdyxICf0Mzp1sE";
        assert_eq!(
            k.decrypt(fixture).unwrap(),
            "cross-language parity check: héllo 世界"
        );
    }

    #[test]
    fn decode_configured_accepts_hex_64() {
        let hex = "00".repeat(32);
        let k = EncryptionKey::decode_configured(&hex).unwrap();
        assert_eq!(k.0.len(), KEY_LEN);
    }

    #[test]
    fn decode_configured_accepts_base64() {
        let b64 = base64::engine::general_purpose::STANDARD.encode([9u8; KEY_LEN]);
        let k = EncryptionKey::decode_configured(&b64).unwrap();
        assert_eq!(k.0.len(), KEY_LEN);
    }

    #[test]
    fn decode_configured_rejects_wrong_length() {
        let short = base64::engine::general_purpose::STANDARD.encode([9u8; 16]);
        assert!(matches!(
            EncryptionKey::decode_configured(&short),
            Err(CryptoError::BadKeyLength)
        ));
    }

    #[test]
    fn load_generates_and_persists_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let k1 = EncryptionKey::load(dir.path()).unwrap();
        assert!(dir.path().join("master.key").exists());
        // A second load must read back the same persisted key, not
        // regenerate, so previously-encrypted values keep decrypting.
        let k2 = EncryptionKey::load(dir.path()).unwrap();
        let ct = k1.encrypt("stable across reloads");
        assert_eq!(k2.decrypt(&ct).unwrap(), "stable across reloads");
    }

    #[test]
    fn load_prefers_env_var_over_key_file() {
        let dir = tempfile::tempdir().unwrap();
        // Seed a key file with one key...
        EncryptionKey::load(dir.path()).unwrap();
        // ...then override with an env-configured key and confirm THAT one
        // is used instead of the file, matching loadEncryptionKey's
        // precedence order exactly.
        let override_key = base64::engine::general_purpose::STANDARD.encode([3u8; KEY_LEN]);
        // SAFETY: test runs single-threaded within this process for this var.
        unsafe {
            std::env::set_var("MIRROR_STORE_KEY", &override_key);
        }
        let loaded = EncryptionKey::load(dir.path()).unwrap();
        unsafe {
            std::env::remove_var("MIRROR_STORE_KEY");
        }
        let expected = EncryptionKey::decode_configured(&override_key).unwrap();
        let ct = expected.encrypt("probe");
        assert_eq!(loaded.decrypt(&ct).unwrap(), "probe");
    }
}
