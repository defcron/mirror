//! gptgif codec — visually encodes bytes as hex digits rendered as 8x8 glyphs
//! in a 640x480 indexed-color GIF animation.
//! Port of `apps/server/src/gptgif.ts` (faithful to `gptgif.c` and `gptungif.py`).

use crate::gif89a::{GifColor, GifError, GifFrame, GifImage, read_gif, write_gif};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use std::io::{Read, Write};

const WIDTH: usize = 640;
const HEIGHT: usize = 480;
const GLYPH_WIDTH: usize = 8;
const GLYPH_HEIGHT: usize = 8;
const COLS: usize = WIDTH / GLYPH_WIDTH; // 80
const ROWS: usize = HEIGHT / GLYPH_HEIGHT; // 60
const FRAME_CHARS: usize = COLS * ROWS; // 4800
const COLOR_COUNT: usize = 256;

pub const FONT: [[u8; 8]; 16] = [
    [0x00, 0x3c, 0x66, 0x6e, 0x76, 0x66, 0x3c, 0x00], // 0
    [0x00, 0x18, 0x38, 0x18, 0x18, 0x18, 0x3c, 0x00], // 1
    [0x00, 0x3c, 0x66, 0x0c, 0x18, 0x30, 0x7e, 0x00], // 2
    [0x00, 0x3c, 0x66, 0x1c, 0x06, 0x66, 0x3c, 0x00], // 3
    [0x00, 0x0c, 0x1c, 0x2c, 0x4c, 0x7e, 0x0c, 0x00], // 4
    [0x00, 0x7e, 0x60, 0x7c, 0x06, 0x66, 0x3c, 0x00], // 5
    [0x00, 0x3c, 0x60, 0x7c, 0x66, 0x66, 0x3c, 0x00], // 6
    [0x00, 0x7e, 0x06, 0x0c, 0x18, 0x30, 0x30, 0x00], // 7
    [0x00, 0x3c, 0x66, 0x3c, 0x66, 0x66, 0x3c, 0x00], // 8
    [0x00, 0x3c, 0x66, 0x66, 0x3e, 0x06, 0x3c, 0x00], // 9
    [0x00, 0x3c, 0x06, 0x3e, 0x66, 0x66, 0x3e, 0x00], // a
    [0x00, 0x60, 0x60, 0x7c, 0x66, 0x66, 0x7c, 0x00], // b
    [0x00, 0x3c, 0x60, 0x60, 0x60, 0x60, 0x3c, 0x00], // c
    [0x00, 0x06, 0x06, 0x3e, 0x66, 0x66, 0x3e, 0x00], // d
    [0x00, 0x3c, 0x66, 0x7e, 0x60, 0x60, 0x3c, 0x00], // e
    [0x00, 0x1c, 0x30, 0x30, 0x7c, 0x30, 0x30, 0x00], // f
];

fn build_palette() -> Vec<GifColor> {
    let mut colors = Vec::with_capacity(COLOR_COUNT);
    colors.push(GifColor { r: 0, g: 0, b: 0 });
    for i in 1..COLOR_COUNT {
        colors.push(GifColor {
            r: if i < 128 { (i * 2) as u8 } else { 255 },
            g: if i < 128 {
                (255 - i * 2) as u8
            } else {
                ((i - 128) * 2) as u8
            },
            b: (255 - i) as u8,
        });
    }
    colors
}

fn draw_char(raster: &mut [u8], x: usize, y: usize, ch: u8, frame: usize) {
    let glyph_idx = match ch {
        b'0'..=b'9' => (ch - b'0') as usize,
        b'a'..=b'f' => (ch - b'a' + 10) as usize,
        _ => return,
    };
    let glyph = FONT[glyph_idx];
    for dy in 0..GLYPH_HEIGHT {
        for dx in 0..GLYPH_WIDTH {
            if (glyph[dy] & (1 << (7 - dx))) != 0 {
                let brightness = 32 + ((frame + dy + dx) % 223);
                raster[(y + dy) * WIDTH + (x + dx)] = brightness as u8;
            }
        }
    }
}

/// Encodes inputs as gptgif animation bytes.
pub fn encode_gptgif(inputs: &[&[u8]]) -> Vec<u8> {
    let mut hex = String::new();
    for &inp in inputs {
        for &b in inp {
            hex.push_str(&format!("{b:02x}"));
        }
    }
    let palette = build_palette();
    let mut frames = Vec::new();

    let hex_bytes = hex.as_bytes();
    let mut offset = 0;
    let mut frame = 0;
    while offset < hex_bytes.len() {
        let end = (offset + FRAME_CHARS).min(hex_bytes.len());
        let chunk = &hex_bytes[offset..end];
        let mut raster = vec![0u8; WIDTH * HEIGHT];
        for (i, &ch) in chunk.iter().enumerate() {
            let row = i / COLS;
            let col = i % COLS;
            draw_char(
                &mut raster,
                col * GLYPH_WIDTH,
                row * GLYPH_HEIGHT,
                ch,
                frame,
            );
        }
        frames.push(GifFrame {
            pixels: raster,
            delay_cs: Some(30),
        });
        offset += FRAME_CHARS;
        frame += 1;
    }

    write_gif(&GifImage {
        width: WIDTH as u16,
        height: HEIGHT as u16,
        global_color_table: palette,
        frames,
    })
}

fn luma(color: GifColor) -> u32 {
    (color.r as u32 * 19595 + color.g as u32 * 38470 + color.b as u32 * 7471 + 0x8000) >> 16
}

pub type GlyphMask = u64;

fn tile_mask(binary: &[u8], width: usize, x0: usize, y0: usize) -> (GlyphMask, usize) {
    let mut mask = 0u64;
    let mut sum = 0usize;
    for dy in 0..GLYPH_HEIGHT {
        for dx in 0..GLYPH_WIDTH {
            if binary[(y0 + dy) * width + (x0 + dx)] != 0 {
                mask |= 1u64 << (dy * GLYPH_WIDTH + dx);
                sum += 1;
            }
        }
    }
    (mask, sum)
}

fn extract_glyph_tiles(gif: &GifImage) -> Vec<GlyphMask> {
    let mut tiles = Vec::new();
    'outer: for frame in &gif.frames {
        let mut binary = vec![0u8; gif.width as usize * gif.height as usize];
        for (i, &pixel) in frame.pixels.iter().enumerate() {
            let color = gif
                .global_color_table
                .get(pixel as usize)
                .copied()
                .unwrap_or_default();
            binary[i] = if luma(color) > 128 { 1 } else { 0 };
        }
        let rows = gif.height as usize / GLYPH_HEIGHT;
        let cols = gif.width as usize / GLYPH_WIDTH;
        for row in 0..rows {
            for col in 0..cols {
                let (mask, sum) = tile_mask(
                    &binary,
                    gif.width as usize,
                    col * GLYPH_WIDTH,
                    row * GLYPH_HEIGHT,
                );
                if sum < 5 {
                    break 'outer;
                }
                tiles.push(mask);
            }
        }
    }
    tiles
}

fn hamming_distance(a: GlyphMask, b: GlyphMask) -> u32 {
    (a ^ b).count_ones()
}

#[derive(Debug, Clone)]
pub struct ClusterResult {
    pub labels: Vec<usize>,
    pub centroids: Vec<Vec<f64>>,
}

pub fn cluster_glyph_tiles(tiles: &[GlyphMask], k: usize) -> ClusterResult {
    let mut cluster_masks = Vec::new();
    let mut labels = vec![0usize; tiles.len()];

    for (i, &mask) in tiles.iter().enumerate() {
        let existing = cluster_masks.iter().position(|&m| m == mask);
        let label = match existing {
            Some(idx) => idx,
            None => {
                if cluster_masks.len() < k {
                    let idx = cluster_masks.len();
                    cluster_masks.push(mask);
                    idx
                } else {
                    let mut best_dist = hamming_distance(mask, cluster_masks[0]);
                    let mut best_label = 0;
                    for (c, &cm) in cluster_masks.iter().enumerate().skip(1) {
                        let d = hamming_distance(mask, cm);
                        if d < best_dist {
                            best_dist = d;
                            best_label = c;
                        }
                    }
                    best_label
                }
            }
        };
        labels[i] = label;
    }

    let mut centroids = vec![vec![0.0; GLYPH_WIDTH * GLYPH_HEIGHT]; k];
    let mut counts = vec![0usize; k];

    for (i, &mask) in tiles.iter().enumerate() {
        let label = labels[i];
        counts[label] += 1;
        for bit in 0..(GLYPH_WIDTH * GLYPH_HEIGHT) {
            if (mask & (1u64 << bit)) != 0 {
                centroids[label][bit] += 1.0;
            }
        }
    }

    for c in 0..k {
        if counts[c] > 0 {
            for bit in 0..(GLYPH_WIDTH * GLYPH_HEIGHT) {
                centroids[c][bit] /= counts[c] as f64;
            }
        }
    }

    ClusterResult { labels, centroids }
}

const DEFAULT_CLUSTER_MAP: &str = "0123456789abcdef";

pub fn calibrate_gptgif(gif_bytes: &[u8], cluster_map: Option<&str>) -> Result<String, GifError> {
    let map = cluster_map.unwrap_or(DEFAULT_CLUSTER_MAP);
    let image = read_gif(gif_bytes)?;
    let tiles = extract_glyph_tiles(&image);
    let ClusterResult { centroids, .. } = cluster_glyph_tiles(&tiles, map.len());

    let mut lines = vec!["K-Means Cluster Centroids (visualized as 8x8 glyphs):".to_string()];
    for (i, centroid) in centroids.iter().enumerate() {
        lines.push(String::new());
        lines.push(format!("Cluster Label: {i}"));
        for row in 0..GLYPH_HEIGHT {
            let mut line = String::new();
            for col in 0..GLYPH_WIDTH {
                line.push(if centroid[row * GLYPH_WIDTH + col] > 0.5 {
                    '#'
                } else {
                    '.'
                });
            }
            lines.push(line);
        }
        lines.push("-".repeat(20));
    }
    lines.push(String::new());
    lines.push(
        "Now associate each index with the correct character from the cluster map.".to_string(),
    );

    Ok(lines.join("\n"))
}

pub fn decode_gptgif(gif_bytes: &[u8], cluster_map: Option<&str>) -> Result<Vec<u8>, GifError> {
    let map = cluster_map.unwrap_or(DEFAULT_CLUSTER_MAP);
    let map_bytes = map.as_bytes();
    let image = read_gif(gif_bytes)?;
    let tiles = extract_glyph_tiles(&image);
    let ClusterResult { labels, .. } = cluster_glyph_tiles(&tiles, map_bytes.len());

    let mut hex = String::new();
    for label in labels {
        if label < map_bytes.len() {
            hex.push(map_bytes[label] as char);
        }
    }

    if !hex.len().is_multiple_of(2) {
        hex.pop();
    }

    let mut raw = Vec::new();
    for i in (0..hex.len()).step_by(2) {
        if let Ok(b) = u8::from_str_radix(&hex[i..i + 2], 16) {
            raw.push(b);
        }
    }

    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(&raw)
        .expect("gzip compression should succeed");
    Ok(encoder.finish().expect("gzip finish should succeed"))
}

pub fn gunzip_gptgif_output(compressed: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut decoder = GzDecoder::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn first_seen_cluster_map(original_hex: &str, alphabet_size: usize) -> String {
        let mut seen = Vec::new();
        for ch in original_hex.chars() {
            if !seen.contains(&ch) {
                seen.push(ch);
                if seen.len() == alphabet_size {
                    break;
                }
            }
        }
        seen.into_iter().collect()
    }

    #[test]
    fn round_trips_16_hex_digits() {
        let input = b"0123456789abcdef 0123456789abcdef";
        let gif = encode_gptgif(&[input]);
        let hex: String = input.iter().map(|b| format!("{b:02x}")).collect();
        let cluster_map = first_seen_cluster_map(&hex, 16);
        let decoded = decode_gptgif(&gif, Some(&cluster_map)).unwrap();
        let decompressed = gunzip_gptgif_output(&decoded).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn concatenates_multiple_inputs() {
        let a = b"hello ";
        let b = b"world";
        let gif = encode_gptgif(&[a, b]);
        let mut hex = String::new();
        for &b_val in a.iter().chain(b.iter()) {
            hex.push_str(&format!("{b_val:02x}"));
        }
        let cluster_map = first_seen_cluster_map(&hex, 16);
        let decoded = decode_gptgif(&gif, Some(&cluster_map)).unwrap();
        let decompressed = gunzip_gptgif_output(&decoded).unwrap();
        assert_eq!(decompressed, b"hello world");
    }

    #[test]
    fn encodes_empty_input_as_zero_frames() {
        let gif = encode_gptgif(&[]);
        let image = read_gif(&gif).unwrap();
        assert_eq!(image.frames.len(), 0);
        let decoded = decode_gptgif(&gif, None).unwrap();
        let decompressed = gunzip_gptgif_output(&decoded).unwrap();
        assert!(decompressed.is_empty());
    }

    #[test]
    fn input_landing_on_frame_boundary() {
        let input = vec![0xabu8; 2400]; // 4800 hex chars
        let gif = encode_gptgif(&[&input]);
        let image = read_gif(&gif).unwrap();
        assert_eq!(image.frames.len(), 1);
        let hex: String = input.iter().map(|b| format!("{b:02x}")).collect();
        let cluster_map = first_seen_cluster_map(&hex, 16);
        let decoded = decode_gptgif(&gif, Some(&cluster_map)).unwrap();
        let decompressed = gunzip_gptgif_output(&decoded).unwrap();
        assert_eq!(decompressed, input);
    }

    #[test]
    fn spills_into_second_frame() {
        let input = vec![0xabu8; 2401];
        let gif = encode_gptgif(&[&input]);
        let image = read_gif(&gif).unwrap();
        assert_eq!(image.frames.len(), 2);
    }

    #[test]
    fn calibrate_renders_all_centroids() {
        let input = b"calibrate me";
        let gif = encode_gptgif(&[input]);
        let report = calibrate_gptgif(&gif, None).unwrap();
        assert!(report.contains("K-Means Cluster Centroids"));
        assert!(report.contains("Cluster Label: 15"));
    }

    #[test]
    fn clusters_merge_when_k_full() {
        let input = b"0123456789abcdef";
        let gif = encode_gptgif(&[input]);
        let report = calibrate_gptgif(&gif, Some("01")).unwrap();
        assert!(report.contains("Cluster Label: 0"));
        assert!(report.contains("Cluster Label: 1"));
        assert!(!report.contains("Cluster Label: 2"));
    }

    #[test]
    fn odd_tile_count_drops_trailing_nibble() {
        let input = [0x12u8];
        let gif = encode_gptgif(&[&input]);
        let mut image = read_gif(&gif).unwrap();
        // Zero out second glyph cell (row 0, col 1)
        for y in 0..GLYPH_HEIGHT {
            for x in 0..GLYPH_WIDTH {
                image.frames[0].pixels[y * WIDTH + (GLYPH_WIDTH + x)] = 0;
            }
        }
        let mutated = write_gif(&image);
        let cluster_map = first_seen_cluster_map("1", 16);
        let decoded = decode_gptgif(&mutated, Some(&cluster_map)).unwrap();
        let decompressed = gunzip_gptgif_output(&decoded).unwrap();
        assert_eq!(decompressed.len(), 0);
    }
}
