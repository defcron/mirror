use axum::{
    Json,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::GzEncoder};
use mirror_formats::{
    EncodeGptgifV4Options, LoafEntry, PngSpeakEncodeOptions, encode_gptgif, encode_gptgif_v4,
    encode_png_speak, pack_loaf,
};
use rand::RngCore;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct ChallengeShelf(pub Arc<Mutex<HashMap<Uuid, Challenge>>>);
pub struct Challenge {
    pub scope: u64,
    pub expected: Vec<u8>,
    pub artifact: Vec<u8>,
    pub format: String,
    pub expires_at: i64,
}
#[derive(Deserialize)]
pub struct CreateBody {
    format: String,
    #[serde(default = "guided")]
    guidance: String,
    #[serde(default = "default_payload")]
    payload: String,
}
fn guided() -> String {
    "guided".into()
}
fn default_payload() -> String {
    "text".into()
}
#[derive(Deserialize)]
pub struct KitBody {
    ids: Vec<String>,
}
#[derive(Deserialize)]
pub struct AnswerBody {
    hex: String,
}
fn bad(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({"error":msg}))).into_response()
}
fn make_artifact(format: &str, bytes: &[u8]) -> Result<Vec<u8>, String> {
    match format {
        "loaf" => pack_loaf(&[LoafEntry {
            name: "payload.bin".into(),
            content: bytes.to_vec(),
            is_dir: false,
        }])
        .map(|s| s.into_bytes())
        .map_err(|e| e.to_string()),
        "pngspeak" => Ok(encode_png_speak(bytes, &PngSpeakEncodeOptions::default())),
        "gptgif" => Ok(encode_gptgif(&[bytes])),
        "gptgif-v4" => encode_gptgif_v4(
            &[bytes],
            &EncodeGptgifV4Options {
                font_seed: Some(rand::random()),
                palette_seed: Some(rand::random()),
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string()),
        _ => Err("format must be loaf, pngspeak, gptgif, or gptgif-v4".into()),
    }
}
pub async fn create(
    State(state): State<Arc<crate::router::AppState>>,
    Json(body): Json<CreateBody>,
) -> Response {
    let shelf = &state.challenges;
    if body.format != "loaf"
        && body.format != "pngspeak"
        && body.format != "gptgif"
        && body.format != "gptgif-v4"
    {
        return bad(StatusCode::BAD_REQUEST, "invalid format");
    }
    if body.guidance != "guided" && body.guidance != "independent"
        || body.payload != "text" && body.payload != "binary"
    {
        return bad(StatusCode::BAD_REQUEST, "invalid challenge options");
    }
    let mut expected = vec![0u8; if body.payload == "binary" { 128 } else { 0 }];
    if body.payload == "binary" {
        rand::thread_rng().fill_bytes(&mut expected);
    } else {
        expected = format!("Mirror decoder expedition\nDiscovery: {}\nKeep every byte: café, stars ✨, and this final newline.\n", Uuid::new_v4().simple()).into_bytes();
    }
    let artifact = match make_artifact(&body.format, &expected) {
        Ok(v) => v,
        Err(e) => return bad(StatusCode::BAD_REQUEST, &e),
    };
    let id = Uuid::new_v4();
    let expires_at = chrono::Utc::now().timestamp_millis() + 86_400_000;
    let scope = state.store.session_revision();
    let filename = format!(
        "decoder-{}.{}",
        id,
        match body.format.as_str() {
            "loaf" => "loaf",
            "pngspeak" => "pngspk.png",
            "gptgif" => "gptgif.gif",
            _ => "gptgif-v4.gif",
        }
    );
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    let _ = gz.write_all(&artifact);
    let transport = STANDARD.encode(gz.finish().unwrap_or_default());
    shelf
        .0
        .lock()
        .unwrap()
        .retain(|_, c| c.expires_at > chrono::Utc::now().timestamp_millis() && c.scope == scope);
    if shelf.0.lock().unwrap().len() >= 64 {
        return bad(
            StatusCode::TOO_MANY_REQUESTS,
            "Challenge shelf is full. Try again after an older challenge expires.",
        );
    }
    shelf.0.lock().unwrap().insert(
        id,
        Challenge {
            scope,
            expected,
            artifact: artifact.clone(),
            format: body.format.clone(),
            expires_at,
        },
    );
    let prompt = format!(
        "Mirror decoder challenge {id}\nFormat: {}. Recover the exact original payload bytes.\nThe artifact is base64(gzip(file bytes)); decompress it before decoding.\nFinish with exactly one line: MIRROR_ANSWER_{id}: HEX\nBEGIN_GZIP_BASE64\n{transport}\nEND_GZIP_BASE64",
        body.format
    );
    ([(header::CACHE_CONTROL,"no-store")],Json(json!({"id":id.to_string(),"format":body.format,"guidance":body.guidance,"payload":body.payload,"filename":filename,"artifactBytes":artifact.len(),"prompt":prompt,"expiresAt":expires_at}))).into_response()
}
pub async fn artifact(
    State(state): State<Arc<crate::router::AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Ok(id) = Uuid::parse_str(&id) else {
        return bad(
            StatusCode::NOT_FOUND,
            "Challenge expired or unavailable. Generate a new one.",
        );
    };
    let artifact = {
        let shelf = state.challenges.0.lock().unwrap();
        shelf
            .get(&id)
            .filter(|c| {
                c.scope == state.store.session_revision()
                    && c.expires_at > chrono::Utc::now().timestamp_millis()
            })
            .map(|c| c.artifact.clone())
    };
    match artifact {
        Some(a) => ([(header::CACHE_CONTROL, "no-store")], a).into_response(),
        None => bad(
            StatusCode::NOT_FOUND,
            "Challenge expired or unavailable. Generate a new one.",
        ),
    }
}
pub async fn verify(
    State(state): State<Arc<crate::router::AppState>>,
    Path(id): Path<String>,
    Json(body): Json<AnswerBody>,
) -> Response {
    let Ok(id) = Uuid::parse_str(&id) else {
        return bad(
            StatusCode::NOT_FOUND,
            "Challenge expired or unavailable. Generate a new one.",
        );
    };
    let Ok(actual) = decode_hex(&body.hex) else {
        return bad(
            StatusCode::BAD_REQUEST,
            "Answer must contain complete hexadecimal byte pairs, without spaces.",
        );
    };
    let expected = {
        let shelf = state.challenges.0.lock().unwrap();
        shelf
            .get(&id)
            .filter(|c| {
                c.scope == state.store.session_revision()
                    && c.expires_at > chrono::Utc::now().timestamp_millis()
            })
            .map(|c| c.expected.clone())
    };
    match expected {
        Some(expected) => {
            let matching = actual.iter().zip(&expected).filter(|(a, b)| a == b).count();
            Json(json!({"verdict":if actual==expected{"exact"}else if matching>0{"partial"}else{"mismatch"},"matchingBytes":matching,"expectedBytes":expected.len(),"actualBytes":actual.len()})).into_response()
        }
        _ => bad(
            StatusCode::NOT_FOUND,
            "Challenge expired or unavailable. Generate a new one.",
        ),
    }
}
fn decode_hex(s: &str) -> Result<Vec<u8>, ()> {
    if s.len() > 8192 || !s.len().is_multiple_of(2) {
        return Err(());
    };
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| ()))
        .collect()
}
pub async fn kit(
    State(state): State<Arc<crate::router::AppState>>,
    Json(body): Json<KitBody>,
) -> Response {
    if body.ids.is_empty() || body.ids.len() > 4 {
        return bad(
            StatusCode::BAD_REQUEST,
            "ids must contain between 1 and 4 challenge IDs",
        );
    }
    let scope = state.store.session_revision();
    let mut tar = tar::Builder::new(Vec::new());
    for raw in body.ids {
        let Ok(id) = Uuid::parse_str(&raw) else {
            return bad(
                StatusCode::NOT_FOUND,
                "Challenge expired or unavailable. Generate a new one.",
            );
        };
        let item = {
            let shelf = state.challenges.0.lock().unwrap();
            shelf
                .get(&id)
                .filter(|c| {
                    c.scope == scope && c.expires_at > chrono::Utc::now().timestamp_millis()
                })
                .map(|c| (c.artifact.clone(), c.format.clone()))
        };
        let Some((artifact, format)) = item else {
            return bad(
                StatusCode::NOT_FOUND,
                "Challenge expired or unavailable. Generate a new one.",
            );
        };
        let mut h = tar::Header::new_gnu();
        h.set_size(artifact.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        if tar
            .append_data(
                &mut h,
                format!("{format}-{id}/decoder-{id}.bin"),
                artifact.as_slice(),
            )
            .is_err()
        {
            return bad(StatusCode::INTERNAL_SERVER_ERROR, "could not create kit");
        }
    }
    let raw = match tar.into_inner() {
        Ok(v) => v,
        Err(_) => return bad(StatusCode::INTERNAL_SERVER_ERROR, "could not create kit"),
    };
    let mut gz = GzEncoder::new(Vec::new(), Compression::default());
    if gz.write_all(&raw).is_err() {
        return bad(StatusCode::INTERNAL_SERVER_ERROR, "could not create kit");
    };
    let out = gz.finish().unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "application/gzip"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"mirror-decoder-kits.tar.gz\"",
            ),
            (header::CACHE_CONTROL, "no-store"),
        ],
        out,
    )
        .into_response()
}
