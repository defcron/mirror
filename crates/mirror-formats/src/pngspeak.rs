//! PngSpeak codec — embeds arbitrary binary data directly as RGBA pixel data inside a PNG.
//! Port of `apps/server/src/pngspeak.ts` (faithful to the reference `pngspeak` CLI).

use crc32fast::Hasher;
use flate2::Compression;
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use rand::RngCore;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BPP: usize = 4; // RGBA

#[derive(Debug, thiserror::Error)]
pub enum PngSpeakError {
    #[error("pngspeak: not a PNG file (bad signature)")]
    BadSignature,
    #[error("pngspeak: invalid chunk structure")]
    InvalidChunk,
    #[error("pngspeak: missing IHDR chunk")]
    MissingIhdr,
    #[error("pngspeak: decompression failed: {0}")]
    DecompressionFailed(String),
    #[error("pngspeak: compression failed: {0}")]
    CompressionFailed(String),
}

#[derive(Debug, Clone, Default)]
pub struct PngSpeakEncodeOptions {
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub length: Option<usize>,
    pub rand: Option<String>,
    pub rand_allow_file_path: Option<bool>,
    pub upscale_width: Option<u32>,
    pub upscale_height: Option<u32>,
}

#[derive(Debug, Clone, Default)]
pub struct PngSpeakDecodeOptions {
    pub length: Option<usize>,
    pub rand: Option<String>,
    pub rand_allow_file_path: Option<bool>,
}

fn read_bytes_from_source(n: usize, rand_source: Option<&str>, allow_file_path: bool) -> Vec<u8> {
    if n == 0 {
        return Vec::new();
    }
    if let Some(source) = rand_source {
        if allow_file_path && Path::new(source).is_file() {
            if let Ok(file_bytes) = fs::read(source) {
                return file_bytes.into_iter().take(n).collect();
            }
        }
        let encoded = source.as_bytes();
        if encoded.is_empty() {
            let mut buf = vec![0u8; n];
            rand::thread_rng().fill_bytes(&mut buf);
            return buf;
        }
        let repeats = (n + encoded.len() - 1) / encoded.len() + 1;
        let mut repeated = Vec::with_capacity(repeats * encoded.len());
        for _ in 0..repeats {
            repeated.extend_from_slice(encoded);
        }
        repeated.truncate(n);
        return repeated;
    }
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

fn chunk_crc(chunk_type: &[u8; 4], data: &[u8]) -> [u8; 4] {
    let mut hasher = Hasher::new();
    hasher.update(chunk_type);
    hasher.update(data);
    hasher.finalize().to_be_bytes()
}

fn write_chunk(chunks: &mut Vec<u8>, chunk_type: &[u8; 4], data: &[u8]) {
    chunks.extend_from_slice(&(data.len() as u32).to_be_bytes());
    chunks.extend_from_slice(chunk_type);
    chunks.extend_from_slice(data);
    chunks.extend_from_slice(&chunk_crc(chunk_type, data));
}

fn minimal_big_endian_hex(value: usize) -> String {
    let bit_length = if value == 0 {
        0
    } else {
        64 - (value as u64).leading_zeros()
    };
    let byte_length = (bit_length + 7) / 8;
    let byte_length = if byte_length == 0 {
        1
    } else {
        byte_length as usize
    };
    let hex_val = format!("{value:x}");
    let target_len = byte_length * 2;
    if hex_val.len() < target_len {
        format!("{:0>width$}", hex_val, width = target_len)
    } else {
        hex_val
    }
}

/// Python's built-in `round()` uses round-half-to-even (banker's rounding).
pub fn python_round(value: f64) -> f64 {
    let floor = value.floor();
    let diff = value - floor;
    if diff < 0.5 {
        floor
    } else if diff > 0.5 {
        floor + 1.0
    } else if (floor as i64) % 2 == 0 {
        floor
    } else {
        floor + 1.0
    }
}

fn bilinear_upscale(data: &[u8], width: usize, height: usize, uw: usize, uh: usize) -> Vec<u8> {
    let mut result = vec![0u8; uw * uh * BPP];
    let get_pixel = |x: usize, y: usize| -> [u8; 4] {
        let offset = (y * width + x) * BPP;
        [
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]
    };

    for out_y in 0..uh {
        for out_x in 0..uw {
            let src_x = ((out_x as f64 + 0.5) * width as f64) / uw as f64 - 0.5;
            let src_y = ((out_y as f64 + 0.5) * height as f64) / uh as f64 - 0.5;

            let x0_raw = src_x.trunc() as i64;
            let y0_raw = src_y.trunc() as i64;

            let x1 = (x0_raw + 1).min(width as i64 - 1).max(0) as usize;
            let y1 = (y0_raw + 1).min(height as i64 - 1).max(0) as usize;

            let x0 = x0_raw.max(0) as usize;
            let y0 = y0_raw.max(0) as usize;

            let dx = src_x - x0 as f64;
            let dy = src_y - y0 as f64;

            let p00 = get_pixel(x0, y0);
            let p10 = get_pixel(x1, y0);
            let p01 = get_pixel(x0, y1);
            let p11 = get_pixel(x1, y1);

            let out_offset = (out_y * uw + out_x) * BPP;
            for c in 0..BPP {
                let top = p00[c] as f64 * (1.0 - dx) + p10[c] as f64 * dx;
                let bottom = p01[c] as f64 * (1.0 - dx) + p11[c] as f64 * dx;
                let val = top * (1.0 - dy) + bottom * dy;
                result[out_offset + c] = python_round(val).clamp(0.0, 255.0) as u8;
            }
        }
    }
    result
}

fn compute_grid_dimensions(
    pixels_needed: usize,
    width: Option<i32>,
    height: Option<i32>,
) -> (usize, usize) {
    match (width, height) {
        (None, None) => {
            let w = 1.max((pixels_needed as f64).sqrt().floor() as usize);
            let h = 1.max(((pixels_needed as f64) / w as f64).ceil() as usize);
            (w, h)
        }
        (None, Some(h_val)) => {
            let h = if h_val <= 0 { 1 } else { h_val as usize };
            let w = 1.max(((pixels_needed as f64) / h as f64).ceil() as usize);
            (w, h)
        }
        (Some(w_val), None) => {
            let w = if w_val <= 0 { 1 } else { w_val as usize };
            let h = 1.max(((pixels_needed as f64) / w as f64).ceil() as usize);
            (w, h)
        }
        (Some(w_val), Some(h_val)) => {
            let w = if w_val <= 0 { 1 } else { w_val as usize };
            let h = if h_val <= 0 { 1 } else { h_val as usize };
            (w, h)
        }
    }
}

/// Encodes arbitrary bytes into a valid PngSpeak PNG image.
pub fn encode_png_speak(input: &[u8], options: &PngSpeakEncodeOptions) -> Vec<u8> {
    let actual_length = input.len();
    let allow_file = options.rand_allow_file_path.unwrap_or(true);

    let (length_for_header, data_to_embed) = if let Some(target_len) = options.length {
        if actual_length < target_len {
            let mut buf = input.to_vec();
            buf.extend(read_bytes_from_source(
                target_len - actual_length,
                options.rand.as_deref(),
                allow_file,
            ));
            (target_len, buf)
        } else if actual_length > target_len {
            (target_len, input[..target_len].to_vec())
        } else {
            (target_len, input.to_vec())
        }
    } else {
        (actual_length, input.to_vec())
    };

    let pixels_needed = 1.max((data_to_embed.len() + BPP - 1) / BPP);
    let (grid_w, grid_h) = compute_grid_dimensions(pixels_needed, options.width, options.height);
    let grid_capacity = grid_w * grid_h * BPP;

    let final_pixel_data = if data_to_embed.len() < grid_capacity {
        let mut buf = data_to_embed;
        buf.extend(read_bytes_from_source(
            grid_capacity - buf.len(),
            options.rand.as_deref(),
            allow_file,
        ));
        buf
    } else if data_to_embed.len() > grid_capacity {
        data_to_embed[..grid_capacity].to_vec()
    } else {
        data_to_embed
    };

    let mut out = Vec::with_capacity(final_pixel_data.len() + 1024);
    out.extend_from_slice(&PNG_SIGNATURE);

    let ihdr_w = options
        .upscale_width
        .filter(|&w| w > 0)
        .unwrap_or(grid_w as u32);
    let ihdr_h = options
        .upscale_height
        .filter(|&h| h > 0)
        .unwrap_or(grid_h as u32);

    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&ihdr_w.to_be_bytes());
    ihdr[4..8].copy_from_slice(&ihdr_h.to_be_bytes());
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter method
    ihdr[12] = 0; // interlace: none
    write_chunk(&mut out, b"IHDR", &ihdr);

    let hex_val_for_header = minimal_big_endian_hex(length_for_header);
    let hex_len_of_part2 = minimal_big_endian_hex(hex_val_for_header.len());
    let itxt_text = format!("{hex_len_of_part2} {hex_val_for_header}");

    let mut itxt_payload = Vec::new();
    itxt_payload.extend_from_slice(b"license\0\0\0\0\0");
    itxt_payload.extend_from_slice(itxt_text.as_bytes());
    write_chunk(&mut out, b"iTXt", &itxt_payload);

    let (data_for_idat, idat_w, idat_h) = if options.upscale_width.is_some()
        && options.upscale_height.is_some()
        && options.upscale_width.unwrap() > 0
        && options.upscale_height.unwrap() > 0
    {
        let uw = options.upscale_width.unwrap() as usize;
        let uh = options.upscale_height.unwrap() as usize;
        (
            bilinear_upscale(&final_pixel_data, grid_w, grid_h, uw, uh),
            uw,
            uh,
        )
    } else {
        (final_pixel_data, grid_w, grid_h)
    };

    let row_bytes = idat_w * BPP;
    let mut raw = vec![0u8; idat_h * (row_bytes + 1)];
    for y in 0..idat_h {
        let row_start = y * (row_bytes + 1);
        raw[row_start] = 0; // filter type: none
        let src_start = y * row_bytes;
        raw[row_start + 1..row_start + 1 + row_bytes]
            .copy_from_slice(&data_for_idat[src_start..src_start + row_bytes]);
    }

    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).expect("zlib encode should succeed");
    let deflated = encoder.finish().expect("zlib finish should succeed");
    write_chunk(&mut out, b"IDAT", &deflated);

    write_chunk(&mut out, b"IEND", &[]);

    out
}

struct RawChunk {
    chunk_type: [u8; 4],
    data: Vec<u8>,
}

fn read_chunks(png: &[u8]) -> Result<Vec<RawChunk>, PngSpeakError> {
    if png.len() < 8 || png[0..8] != PNG_SIGNATURE {
        return Err(PngSpeakError::BadSignature);
    }
    let mut chunks = Vec::new();
    let mut offset = 8;
    while offset + 8 <= png.len() {
        let length = u32::from_be_bytes(png[offset..offset + 4].try_into().unwrap()) as usize;
        let mut chunk_type = [0u8; 4];
        chunk_type.copy_from_slice(&png[offset + 4..offset + 8]);
        if offset + 8 + length + 4 > png.len() {
            return Err(PngSpeakError::InvalidChunk);
        }
        let data = png[offset + 8..offset + 8 + length].to_vec();
        chunks.push(RawChunk { chunk_type, data });
        offset += 8 + length + 4;
        if &chunk_type == b"IEND" {
            break;
        }
    }
    Ok(chunks)
}

/// Decodes a PngSpeak PNG back into its embedded bytes.
pub fn decode_png_speak(
    png: &[u8],
    options: &PngSpeakDecodeOptions,
) -> Result<Vec<u8>, PngSpeakError> {
    let chunks = read_chunks(png)?;
    let mut width: Option<usize> = None;
    let mut height: Option<usize> = None;
    let mut idat_parts = Vec::new();
    let mut decoded_length_from_header: Option<usize> = None;

    for chunk in chunks {
        if &chunk.chunk_type == b"IHDR" && chunk.data.len() >= 8 {
            width = Some(u32::from_be_bytes(chunk.data[0..4].try_into().unwrap()) as usize);
            height = Some(u32::from_be_bytes(chunk.data[4..8].try_into().unwrap()) as usize);
        } else if &chunk.chunk_type == b"IDAT" {
            idat_parts.extend_from_slice(&chunk.data);
        } else if &chunk.chunk_type == b"iTXt" && decoded_length_from_header.is_none() {
            let mut null_positions = Vec::new();
            for (i, &b) in chunk.data.iter().enumerate() {
                if b == 0 {
                    null_positions.push(i);
                    if null_positions.len() >= 5 {
                        break;
                    }
                }
            }
            if null_positions.len() >= 4 {
                let keyword = &chunk.data[0..null_positions[0]];
                if keyword == b"license" {
                    let text_start = if null_positions.len() >= 5 {
                        null_positions[4] + 1
                    } else {
                        null_positions[3] + 1
                    };
                    if text_start < chunk.data.len() {
                        let text = String::from_utf8_lossy(&chunk.data[text_start..]);
                        let parts: Vec<&str> = text.trim().split(' ').collect();
                        if parts.len() == 2 {
                            if let Ok(parsed) = usize::from_str_radix(parts[1], 16) {
                                decoded_length_from_header = Some(parsed);
                            }
                        }
                    }
                }
            }
        }
    }

    let width = width.ok_or(PngSpeakError::MissingIhdr)?;
    let height = height.ok_or(PngSpeakError::MissingIhdr)?;

    let mut decoder = ZlibDecoder::new(&idat_parts[..]);
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .map_err(|e| PngSpeakError::DecompressionFailed(e.to_string()))?;

    let row_size = 1 + width * BPP;
    let mut pixel_data = vec![0u8; height * width * BPP];
    for y in 0..height {
        let row_start = y * row_size;
        if row_start + row_size <= decompressed.len() {
            pixel_data[y * width * BPP..(y + 1) * width * BPP]
                .copy_from_slice(&decompressed[row_start + 1..row_start + row_size]);
        }
    }

    let final_length_target = options.length.or(decoded_length_from_header);
    let max_embedded_bytes = width * height * BPP;

    let allow_file = options.rand_allow_file_path.unwrap_or(true);
    match final_length_target {
        None => Ok(pixel_data[..max_embedded_bytes.min(pixel_data.len())].to_vec()),
        Some(target) if target <= max_embedded_bytes => {
            Ok(pixel_data[..target.min(pixel_data.len())].to_vec())
        }
        Some(target) => {
            let mut out = pixel_data[..max_embedded_bytes.min(pixel_data.len())].to_vec();
            out.extend(read_bytes_from_source(
                target - max_embedded_bytes,
                options.rand.as_deref(),
                allow_file,
            ));
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_round_matches_python_bankers_rounding() {
        assert_eq!(python_round(2.5), 2.0);
        assert_eq!(python_round(3.5), 4.0);
        assert_eq!(python_round(-0.5), 0.0);
        assert_eq!(python_round(2.4), 2.0);
        assert_eq!(python_round(2.6), 3.0);
    }

    #[test]
    fn encodes_and_decodes_small_text_round_trip() {
        let input = b"hello pngspeak\n";
        let png = encode_png_speak(input, &PngSpeakEncodeOptions::default());
        assert_eq!(&png[0..8], &PNG_SIGNATURE);
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, input);
    }

    #[test]
    fn round_trips_binary_data() {
        let input = [0, 1, 2, 255, 254, 253, 0, 0, 128];
        let png = encode_png_speak(&input, &PngSpeakEncodeOptions::default());
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, &input);
    }

    #[test]
    fn round_trips_empty_input() {
        let png = encode_png_speak(&[], &PngSpeakEncodeOptions::default());
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert!(decoded.is_empty());
    }

    #[test]
    fn fixed_grid_width_and_height_round_trips() {
        let input = b"0123456789abcdef"; // 4 pixels
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(2),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, input);

        let png_h = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                height: Some(2),
                ..Default::default()
            },
        );
        let decoded_h = decode_png_speak(&png_h, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded_h, input);
    }

    #[test]
    fn fixed_dimensions_larger_than_needed_pads_cleanly() {
        let input = b"hi";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(3),
                height: Some(3),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, input);
    }

    #[test]
    fn length_pads_short_input_and_embeds_header() {
        let input = b"hi";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                length: Some(10),
                rand: Some("X".into()),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(decoded.len(), 10);
        assert_eq!(&decoded[0..2], b"hi");
    }

    #[test]
    fn zero_and_negative_dimensions_normalize_to_one() {
        let input = b"0123456789abcdef";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(2),
                height: Some(0),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(
            &png,
            &PngSpeakDecodeOptions {
                length: Some(8),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(&decoded, &input[0..8]);

        let png2 = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(-1),
                height: Some(2),
                ..Default::default()
            },
        );
        let decoded2 = decode_png_speak(
            &png2,
            &PngSpeakDecodeOptions {
                length: Some(8),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(&decoded2, &input[0..8]);
    }

    #[test]
    fn length_truncates_long_input() {
        let input = b"this is definitely too long";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                length: Some(4),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, b"this");
    }

    #[test]
    fn rand_string_is_repeated_deterministically() {
        let png1 = encode_png_speak(
            b"a",
            &PngSpeakEncodeOptions {
                length: Some(5),
                rand: Some("XY".into()),
                ..Default::default()
            },
        );
        let png2 = encode_png_speak(
            b"a",
            &PngSpeakEncodeOptions {
                length: Some(5),
                rand: Some("XY".into()),
                ..Default::default()
            },
        );
        assert_eq!(png1, png2);
        let decoded = decode_png_speak(&png1, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, b"aXYXY");
    }

    #[test]
    fn rand_from_file_reads_padding() {
        let temp_dir =
            std::env::temp_dir().join(format!("pngspeak-test-{}", rand::random::<u32>()));
        let _ = fs::create_dir_all(&temp_dir);
        let file_path = temp_dir.join("pad.bin");
        fs::write(&file_path, b"PADDINGBYTES").unwrap();

        let png = encode_png_speak(
            b"a",
            &PngSpeakEncodeOptions {
                length: Some(5),
                rand: Some(file_path.to_str().unwrap().into()),
                rand_allow_file_path: Some(true),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, b"aPADD");

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn art_mode_upscale_produces_larger_ihdr() {
        let input = b"small payload for art";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(4),
                upscale_width: Some(32),
                upscale_height: Some(32),
                ..Default::default()
            },
        );
        let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
        assert_eq!(width, 32);
        assert_eq!(height, 32);
    }

    #[test]
    fn rejects_invalid_png() {
        assert!(matches!(
            decode_png_speak(b"not a png", &PngSpeakDecodeOptions::default()),
            Err(PngSpeakError::BadSignature)
        ));
    }

    #[test]
    fn length_matching_input_exact() {
        let input = b"exact";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                length: Some(input.len()),
                ..Default::default()
            },
        );
        let decoded = decode_png_speak(&png, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(&decoded, input);
    }

    #[test]
    fn rand_empty_string_generates_random_padding() {
        let p1 = read_bytes_from_source(8, Some(""), false);
        let p2 = read_bytes_from_source(8, Some(""), false);
        assert_eq!(p1.len(), 8);
        assert_eq!(p2.len(), 8);
        assert_eq!(read_bytes_from_source(0, Some(""), false).len(), 0);
    }

    #[test]
    fn rejects_truncated_chunk() {
        let mut truncated = Vec::new();
        truncated.extend_from_slice(&PNG_SIGNATURE);
        truncated.extend_from_slice(&100u32.to_be_bytes());
        truncated.extend_from_slice(b"IHDR");
        truncated.extend_from_slice(&[0u8; 10]); // shorter than 100
        assert!(matches!(
            decode_png_speak(&truncated, &PngSpeakDecodeOptions::default()),
            Err(PngSpeakError::InvalidChunk)
        ));
    }

    #[test]
    fn decode_without_length_header_returns_full_grid() {
        let input = b"0123456789abcdef";
        let png = encode_png_speak(
            input,
            &PngSpeakEncodeOptions {
                width: Some(2),
                height: Some(2),
                ..Default::default()
            },
        );
        let itxt_pos = png.windows(4).position(|w| w == b"iTXt").unwrap();
        let chunk_start = itxt_pos - 4;
        let chunk_len =
            u32::from_be_bytes(png[chunk_start..chunk_start + 4].try_into().unwrap()) as usize;
        let mut stripped = Vec::new();
        stripped.extend_from_slice(&png[..chunk_start]);
        stripped.extend_from_slice(&png[chunk_start + 12 + chunk_len..]);

        let decoded = decode_png_speak(&stripped, &PngSpeakDecodeOptions::default()).unwrap();
        assert_eq!(decoded.len(), 16);
        assert_eq!(&decoded, input);
    }

    #[test]
    fn decode_with_length_greater_than_grid_pads_result() {
        let input = b"short";
        let png = encode_png_speak(input, &PngSpeakEncodeOptions::default());
        let decoded = decode_png_speak(
            &png,
            &PngSpeakDecodeOptions {
                length: Some(20),
                rand: Some("Z".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(decoded.len(), 20);
        assert_eq!(&decoded[..5], input);
    }
}
