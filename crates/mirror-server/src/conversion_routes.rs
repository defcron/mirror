use axum::Router;
use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use base64::prelude::*;
use mirror_formats::gptgif::{
    calibrate_gptgif, decode_gptgif, encode_gptgif, gunzip_gptgif_output,
};
use mirror_formats::gptgif_v4::{
    EncodeGptgifV4Options, decode_gptgif_v4, default_palette, encode_gptgif_v4, font_from_bytes,
    font_to_bytes, palette_from_bytes, palette_to_bytes, random_font, random_palette,
};
use mirror_formats::loaf::{LoafEntry, pack_loaf, unpack_loaf};
use mirror_formats::pngspeak::{
    PngSpeakDecodeOptions, PngSpeakEncodeOptions, decode_png_speak, encode_png_speak,
};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn conversion_routes<S: Clone + Send + Sync + 'static>() -> Router<S> {
    Router::new()
        .route("/api/convert/formats", get(formats_handler))
        .route("/api/convert/loaf/encode", post(loaf_encode_handler))
        .route("/api/convert/loaf/decode", post(loaf_decode_handler))
        .route(
            "/api/convert/pngspeak/encode",
            post(pngspeak_encode_handler),
        )
        .route(
            "/api/convert/pngspeak/decode",
            post(pngspeak_decode_handler),
        )
        .route("/api/convert/gptgif/encode", post(gptgif_encode_handler))
        .route("/api/convert/gptgif/decode", post(gptgif_decode_handler))
        .route(
            "/api/convert/gptgif/calibrate",
            post(gptgif_calibrate_handler),
        )
        .route(
            "/api/convert/gptgif-v4/encode",
            post(gptgif_v4_encode_handler),
        )
        .route(
            "/api/convert/gptgif-v4/decode",
            post(gptgif_v4_decode_handler),
        )
        .route(
            "/api/convert/gptgif-v4/font/default",
            get(gptgif_v4_font_default_handler),
        )
        .route(
            "/api/convert/gptgif-v4/font/random",
            get(gptgif_v4_font_random_handler),
        )
        .route(
            "/api/convert/gptgif-v4/palette/default",
            get(gptgif_v4_palette_default_handler),
        )
        .route(
            "/api/convert/gptgif-v4/palette/random",
            get(gptgif_v4_palette_random_handler),
        )
}

async fn formats_handler() -> Response {
    Json(json!({
        "formats": [
            {
                "id": "loaf",
                "label": "LoaF",
                "extension": "loaf",
                "mime": "text/plain",
                "roundTrips": true,
                "blurb": "A tar+gzip archive hex-encoded onto a single checksummed line."
            },
            {
                "id": "pngspeak",
                "label": "PngSpeak",
                "extension": "pngspk.png",
                "mime": "image/png",
                "roundTrips": true,
                "blurb": "Raw bytes stored one-to-one as RGBA pixels in an uncompressed-scanline PNG."
            },
            {
                "id": "gptgif",
                "label": "gptgif (original)",
                "extension": "gptgif.gif",
                "mime": "image/gif",
                "roundTrips": false,
                "blurb": "Bytes rendered as a grid of glyph tiles in an animated GIF; decoding needs a calibrated cluster map."
            },
            {
                "id": "gptgif-v4",
                "label": "gptgif v4",
                "extension": "gptgif-v4.gif",
                "mime": "image/gif",
                "roundTrips": true,
                "blurb": "gptgif with a randomizable glyph font and color palette."
            }
        ]
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct LoafEntryIn {
    name: String,
    #[serde(rename = "contentBase64")]
    content_base64: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoafEncodeBody {
    entries: Vec<LoafEntryIn>,
}

async fn loaf_encode_handler(Json(body): Json<LoafEncodeBody>) -> Response {
    let mut entries = Vec::new();
    for e in body.entries {
        let content = if let Some(b64) = e.content_base64 {
            match BASE64_STANDARD.decode(&b64) {
                Ok(bytes) => bytes,
                Err(err) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("Invalid base64: {err}") })),
                    )
                        .into_response();
                }
            }
        } else {
            Vec::new()
        };
        entries.push(LoafEntry {
            name: e.name,
            content,
            is_dir: false,
        });
    }

    match pack_loaf(&entries) {
        Ok(loaf) => Json(json!({
            "format": "loaf",
            "loaf": loaf,
            "bytes": loaf.len(),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct LoafDecodeBody {
    loaf: String,
}

async fn loaf_decode_handler(Json(body): Json<LoafDecodeBody>) -> Response {
    match unpack_loaf(&body.loaf) {
        Ok(extracted) => {
            let entries: Vec<Value> = extracted
                .into_iter()
                .map(|e| {
                    json!({
                        "name": e.name,
                        "isDirectory": e.is_dir,
                        "bytes": e.content.len(),
                        "contentBase64": BASE64_STANDARD.encode(&e.content),
                    })
                })
                .collect();
            Json(json!({ "entries": entries })).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct PngSpeakEncodeBody {
    #[serde(rename = "dataBase64")]
    data_base64: String,
    width: Option<i32>,
    height: Option<i32>,
    length: Option<usize>,
    rand: Option<String>,
    #[serde(rename = "upscaleWidth")]
    upscale_width: Option<u32>,
    #[serde(rename = "upscaleHeight")]
    upscale_height: Option<u32>,
}

async fn pngspeak_encode_handler(Json(body): Json<PngSpeakEncodeBody>) -> Response {
    let data = match BASE64_STANDARD.decode(&body.data_base64) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64: {e}") })),
            )
                .into_response();
        }
    };

    let artifact = encode_png_speak(
        &data,
        &PngSpeakEncodeOptions {
            width: body.width,
            height: body.height,
            length: body.length,
            rand: body.rand,
            rand_allow_file_path: Some(false),
            upscale_width: body.upscale_width,
            upscale_height: body.upscale_height,
        },
    );

    Json(json!({
        "format": "pngspeak",
        "bytes": artifact.len(),
        "dataBase64": BASE64_STANDARD.encode(&artifact),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct PngSpeakDecodeBody {
    #[serde(rename = "dataBase64")]
    data_base64: String,
    length: Option<usize>,
    rand: Option<String>,
}

async fn pngspeak_decode_handler(Json(body): Json<PngSpeakDecodeBody>) -> Response {
    let artifact = match BASE64_STANDARD.decode(&body.data_base64) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64: {e}") })),
            )
                .into_response();
        }
    };

    match decode_png_speak(
        &artifact,
        &PngSpeakDecodeOptions {
            length: body.length,
            rand: body.rand,
            rand_allow_file_path: Some(false),
        },
    ) {
        Ok(recovered) => Json(json!({
            "bytes": recovered.len(),
            "dataBase64": BASE64_STANDARD.encode(&recovered),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct GptgifEncodeBody {
    #[serde(rename = "dataBase64")]
    data_base64: Option<String>,
    parts: Option<Vec<String>>,
}

async fn gptgif_encode_handler(Json(body): Json<GptgifEncodeBody>) -> Response {
    let mut inputs = Vec::new();
    if let Some(parts) = body.parts {
        for p in parts {
            match BASE64_STANDARD.decode(&p) {
                Ok(bytes) => inputs.push(bytes),
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("Invalid base64: {e}") })),
                    )
                        .into_response();
                }
            }
        }
    } else if let Some(b64) = body.data_base64 {
        match BASE64_STANDARD.decode(&b64) {
            Ok(bytes) => inputs.push(bytes),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("Invalid base64: {e}") })),
                )
                    .into_response();
            }
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Provide exactly one of dataBase64 or parts" })),
        )
            .into_response();
    }

    let input_slices: Vec<&[u8]> = inputs.iter().map(|v| v.as_slice()).collect();
    let artifact = encode_gptgif(&input_slices);

    Json(json!({
        "format": "gptgif",
        "bytes": artifact.len(),
        "dataBase64": BASE64_STANDARD.encode(&artifact),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct GptgifDecodeBody {
    #[serde(rename = "dataBase64")]
    data_base64: String,
    #[serde(rename = "clusterMap")]
    cluster_map: Option<String>,
}

async fn gptgif_decode_handler(Json(body): Json<GptgifDecodeBody>) -> Response {
    let artifact = match BASE64_STANDARD.decode(&body.data_base64) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64: {e}") })),
            )
                .into_response();
        }
    };

    match decode_gptgif(&artifact, body.cluster_map.as_deref()) {
        Ok(gzip_bytes) => match gunzip_gptgif_output(&gzip_bytes) {
            Ok(recovered) => Json(json!({
                "bytes": recovered.len(),
                "dataBase64": BASE64_STANDARD.encode(&recovered),
            }))
            .into_response(),
            Err(e) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Gunzip failed: {e}") })),
            )
                .into_response(),
        },
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn gptgif_calibrate_handler(Json(body): Json<GptgifDecodeBody>) -> Response {
    let artifact = match BASE64_STANDARD.decode(&body.data_base64) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64: {e}") })),
            )
                .into_response();
        }
    };

    match calibrate_gptgif(&artifact, body.cluster_map.as_deref()) {
        Ok(report) => Json(json!({ "report": report })).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct GptgifV4EncodeBody {
    #[serde(rename = "dataBase64")]
    data_base64: Option<String>,
    parts: Option<Vec<String>>,
    #[serde(rename = "fontSeed")]
    font_seed: Option<u32>,
    #[serde(rename = "paletteSeed")]
    palette_seed: Option<u32>,
    #[serde(rename = "fontBase64")]
    font_base64: Option<String>,
    #[serde(rename = "paletteBase64")]
    palette_base64: Option<String>,
}

async fn gptgif_v4_encode_handler(Json(body): Json<GptgifV4EncodeBody>) -> Response {
    let mut inputs = Vec::new();
    if let Some(parts) = body.parts {
        for p in parts {
            match BASE64_STANDARD.decode(&p) {
                Ok(bytes) => inputs.push(bytes),
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": format!("Invalid base64: {e}") })),
                    )
                        .into_response();
                }
            }
        }
    } else if let Some(b64) = body.data_base64 {
        match BASE64_STANDARD.decode(&b64) {
            Ok(bytes) => inputs.push(bytes),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("Invalid base64: {e}") })),
                )
                    .into_response();
            }
        }
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Provide exactly one of dataBase64 or parts" })),
        )
            .into_response();
    }

    let font = if let Some(font_b64) = body.font_base64 {
        let font_bytes = match BASE64_STANDARD.decode(&font_b64) {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("Invalid font base64: {e}") })),
                )
                    .into_response();
            }
        };
        match font_from_bytes(&font_bytes) {
            Ok(f) => Some(f),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
        }
    } else {
        None
    };

    let palette = if let Some(pal_b64) = body.palette_base64 {
        let pal_bytes = match BASE64_STANDARD.decode(&pal_b64) {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": format!("Invalid palette base64: {e}") })),
                )
                    .into_response();
            }
        };
        match palette_from_bytes(&pal_bytes) {
            Ok(p) => Some(p),
            Err(e) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
        }
    } else {
        None
    };

    let input_slices: Vec<&[u8]> = inputs.iter().map(|v| v.as_slice()).collect();
    let opts = EncodeGptgifV4Options {
        font,
        font_seed: body.font_seed,
        palette,
        palette_seed: body.palette_seed,
    };

    match encode_gptgif_v4(&input_slices, &opts) {
        Ok(artifact) => Json(json!({
            "format": "gptgif-v4",
            "bytes": artifact.len(),
            "dataBase64": BASE64_STANDARD.encode(&artifact),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct DataOnlyBody {
    #[serde(rename = "dataBase64")]
    data_base64: String,
}

async fn gptgif_v4_decode_handler(Json(body): Json<DataOnlyBody>) -> Response {
    let artifact = match BASE64_STANDARD.decode(&body.data_base64) {
        Ok(d) => d,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("Invalid base64: {e}") })),
            )
                .into_response();
        }
    };

    match decode_gptgif_v4(&artifact) {
        Ok(recovered) => Json(json!({
            "bytes": recovered.len(),
            "dataBase64": BASE64_STANDARD.encode(&recovered),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

async fn gptgif_v4_font_default_handler() -> Response {
    let bytes = font_to_bytes(&mirror_formats::gptgif::FONT);
    Json(json!({
        "bytes": bytes.len(),
        "fontBase64": BASE64_STANDARD.encode(bytes),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct SeedQuery {
    seed: Option<u32>,
}

async fn gptgif_v4_font_random_handler(Query(q): Query<SeedQuery>) -> Response {
    let seed = q.seed.unwrap_or(12345);
    let font = random_font(seed);
    let bytes = font_to_bytes(&font);
    Json(json!({
        "seed": seed,
        "bytes": bytes.len(),
        "fontBase64": BASE64_STANDARD.encode(bytes),
    }))
    .into_response()
}

async fn gptgif_v4_palette_default_handler() -> Response {
    let pal = default_palette();
    let bytes = palette_to_bytes(&pal);
    Json(json!({
        "bytes": bytes.len(),
        "paletteBase64": BASE64_STANDARD.encode(bytes),
    }))
    .into_response()
}

async fn gptgif_v4_palette_random_handler(Query(q): Query<SeedQuery>) -> Response {
    let seed = q.seed.unwrap_or(67890);
    let pal = random_palette(seed);
    let bytes = palette_to_bytes(&pal);
    Json(json!({
        "seed": seed,
        "bytes": bytes.len(),
        "paletteBase64": BASE64_STANDARD.encode(bytes),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn formats_discovery_responds() {
        let app = conversion_routes();
        let req = Request::builder()
            .uri("/api/convert/formats")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn loaf_encode_and_decode_round_trip() {
        let app = conversion_routes();
        let payload = BASE64_STANDARD.encode(b"Hello LoaF API");

        let req = Request::builder()
            .method("POST")
            .uri("/api/convert/loaf/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"entries":[{{"name":"test.txt","contentBase64":"{payload}"}}]}}"#
            )))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let loaf_str = body["loaf"].as_str().unwrap();

        let req2 = Request::builder()
            .method("POST")
            .uri("/api/convert/loaf/decode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"loaf":"{loaf_str}"}}"#)))
            .unwrap();
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn pngspeak_encode_and_decode_round_trip() {
        let app = conversion_routes();
        let payload = BASE64_STANDARD.encode(b"Hello PngSpeak API");

        let req = Request::builder()
            .method("POST")
            .uri("/api/convert/pngspeak/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"dataBase64":"{payload}"}}"#)))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let png_b64 = body["dataBase64"].as_str().unwrap();

        let req2 = Request::builder()
            .method("POST")
            .uri("/api/convert/pngspeak/decode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"dataBase64":"{png_b64}"}}"#)))
            .unwrap();
        let resp2 = app.oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn gptgif_v4_font_and_palette_routes() {
        let app = conversion_routes();

        let req = Request::builder()
            .uri("/api/convert/gptgif-v4/font/default")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .uri("/api/convert/gptgif-v4/font/random?seed=42")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .uri("/api/convert/gptgif-v4/palette/default")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let req = Request::builder()
            .uri("/api/convert/gptgif-v4/palette/random?seed=99")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn gptgif_encode_calibrate_and_decode() {
        let app = conversion_routes::<()>();
        let payload = BASE64_STANDARD.encode(b"0123456789abcdef");

        // Encode with dataBase64
        let req = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"dataBase64":"{payload}"}}"#)))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let gif_b64 = body["dataBase64"].as_str().unwrap();

        // Calibrate
        let req_cal = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif/calibrate")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"dataBase64":"{gif_b64}"}}"#)))
            .unwrap();
        let resp_cal = app.clone().oneshot(req_cal).await.unwrap();
        assert_eq!(resp_cal.status(), StatusCode::OK);

        // Decode
        let req_dec = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif/decode")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"dataBase64":"{gif_b64}","clusterMap":"0123456789abcdef"}}"#
            )))
            .unwrap();
        let resp_dec = app.clone().oneshot(req_dec).await.unwrap();
        assert_eq!(resp_dec.status(), StatusCode::OK);

        // Test with parts
        let req_parts = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"parts":["{payload}"]}}"#)))
            .unwrap();
        let resp_parts = app.oneshot(req_parts).await.unwrap();
        assert_eq!(resp_parts.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn gptgif_v4_encode_and_decode() {
        let app = conversion_routes::<()>();
        let payload = BASE64_STANDARD.encode(b"v4 payload test");

        let req = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif-v4/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(
                r#"{{"dataBase64":"{payload}","fontSeed":123,"paletteSeed":456}}"#
            )))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let gif_b64 = body["dataBase64"].as_str().unwrap();

        let req2 = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif-v4/decode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"dataBase64":"{gif_b64}"}}"#)))
            .unwrap();
        let resp2 = app.clone().oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);

        // Test with parts
        let req_parts = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif-v4/encode")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"parts":["{payload}"]}}"#)))
            .unwrap();
        let resp_parts = app.oneshot(req_parts).await.unwrap();
        assert_eq!(resp_parts.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn conversion_routes_reject_malformed_inputs() {
        let app = conversion_routes::<()>();

        // Invalid base64 in pngspeak
        let req = Request::builder()
            .method("POST")
            .uri("/api/convert/pngspeak/encode")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"dataBase64":"not!valid!base64"}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // gptgif with neither dataBase64 nor parts
        let req2 = Request::builder()
            .method("POST")
            .uri("/api/convert/gptgif/encode")
            .header("content-type", "application/json")
            .body(Body::from(r#"{}"#))
            .unwrap();
        let resp2 = app.clone().oneshot(req2).await.unwrap();
        assert_eq!(resp2.status(), StatusCode::BAD_REQUEST);

        // loaf decode with malformed loaf text
        let req3 = Request::builder()
            .method("POST")
            .uri("/api/convert/loaf/decode")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"loaf":"not-a-loaf"}"#))
            .unwrap();
        let resp3 = app.oneshot(req3).await.unwrap();
        assert_eq!(resp3.status(), StatusCode::BAD_REQUEST);
    }
}
