//! gptgif v4: a self-calibrating steganographic format where the visual
//! alphabet, color roles, and header are all learned from frame zero of the
//! GIF itself, rather than hard-coded in the decoder.
//! Native port of `apps/server/src/gptgif-v4.ts` (faithful to `gptgif-v4.c` and `gptungif-v4.py`).

use crate::gif89a::{read_gif, write_gif, GifColor, GifError, GifFrame, GifImage};
use crate::gptgif::FONT as DEFAULT_FONT;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const WIDTH: usize = 640;
const HEIGHT: usize = 480;
const GLYPH_W: usize = 8;
const GLYPH_H: usize = 8;
const COLS: usize = WIDTH / GLYPH_W; // 80
const ROWS: usize = HEIGHT / GLYPH_H; // 60
const FRAME_CHARS: usize = COLS * ROWS; // 4800
const FRAME_BYTES: usize = FRAME_CHARS / 2; // 2400
const NCOLORS: usize = 256;
const LEGEND_START: usize = 320;
const HEADER_START: usize = 400;
const HEADER_BYTES: usize = 48;
const MAGIC: &[u8; 8] = b"GPTGIF4\0";

pub type GlyphFont = [[u8; 8]; 16];

#[derive(Debug, thiserror::Error)]
pub enum GptgifV4Error {
    #[error("gptgif-v4: {0}")]
    Validation(String),
    #[error("gptgif-v4: gif error: {0}")]
    Gif(#[from] GifError),
    #[error("gptungif-v4: {0}")]
    Decode(String),
}

fn build_boustrophedon() -> [u16; FRAME_CHARS] {
    let mut table = [0u16; FRAME_CHARS];
    for col in 0..COLS {
        for row in 0..ROWS {
            let logical = col * ROWS + row;
            let physical_row = if (col & 1) != 0 { ROWS - 1 - row } else { row };
            table[logical] = (col * ROWS + physical_row) as u16;
        }
    }
    table
}

fn xorshift32(mut state: u32) -> u32 {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    state
}

fn rotate_pixel(x: i32, y: i32, rotation: usize) -> (i32, i32) {
    match rotation {
        0 => (x, y),
        1 => (7 - y, x),
        2 => (7 - x, 7 - y),
        _ => (y, 7 - x),
    }
}

pub fn validate_font(font: &GlyphFont) -> Result<(), GptgifV4Error> {
    for rot in 0..4 {
        for jx in -1..=1 {
            for jy in -1..=1 {
                for holes_flag in 0..=1 {
                    let holes = holes_flag == 1;
                    let mut masks = Vec::with_capacity(16);
                    for (n, glyph) in font.iter().enumerate() {
                        let mut mask = 0u64;
                        for y in 0..GLYPH_H {
                            for x in 0..GLYPH_W {
                                if (glyph[y] & (1 << (7 - x))) == 0 {
                                    continue;
                                }
                                if holes && ((x + y) % 2 == 1) {
                                    continue;
                                }
                                let (mut u, mut v) = rotate_pixel(x as i32, y as i32, rot);
                                u += jx;
                                v += jy;
                                if !(0..8).contains(&u) || !(0..8).contains(&v) {
                                    return Err(GptgifV4Error::Validation(format!(
                                        "font glyph {n:x} escapes its cell under jitter"
                                    )));
                                }
                                mask |= 1u64 << (v as usize * GLYPH_W + u as usize);
                            }
                        }
                        if mask == 0 {
                            return Err(GptgifV4Error::Validation(format!(
                                "font glyph {n:x} disappears under an allowed transform"
                            )));
                        }
                        for (other, &prev_mask) in masks.iter().enumerate() {
                            if prev_mask == mask {
                                return Err(GptgifV4Error::Validation(format!(
                                    "font glyphs {other:x} and {n:x} collide under an allowed transform"
                                )));
                            }
                        }
                        masks.push(mask);
                    }
                }
            }
        }
    }
    Ok(())
}

const MARKER_X: [usize; 4] = [1, 2, 3, 4];
const MARKER_Y: [usize; 4] = [1, 2, 3, 4];
const FIXED_X: usize = 5;
const FIXED_Y: usize = 5;

pub fn random_font(seed_in: u32) -> GlyphFont {
    let mut seed = if seed_in == 0 { 0x6d2b79f5 } else { seed_in };
    let mut font = [[0u8; GLYPH_H]; 16];
    for (nibble, glyph) in font.iter_mut().enumerate() {
        for y in 1..=6 {
            for x in 1..=6 {
                let mut reserved = x == FIXED_X && y == FIXED_Y;
                for bit in 0..4 {
                    if x == MARKER_X[bit] && y == MARKER_Y[bit] {
                        reserved = true;
                    }
                }
                seed = xorshift32(seed);
                if !reserved && (seed & 1) != 0 {
                    glyph[y] |= 1 << (7 - x);
                }
            }
        }
        glyph[FIXED_Y] |= 1 << (7 - FIXED_X);
        for bit in 0..4 {
            if (nibble & (1 << bit)) != 0 {
                glyph[MARKER_Y[bit]] |= 1 << (7 - MARKER_X[bit]);
            }
        }
    }
    font
}

pub fn font_to_bytes(font: &GlyphFont) -> [u8; 128] {
    let mut out = [0u8; 128];
    for n in 0..16 {
        for y in 0..GLYPH_H {
            out[n * 8 + y] = font[n][y];
        }
    }
    out
}

pub fn font_from_bytes(bytes: &[u8]) -> Result<GlyphFont, GptgifV4Error> {
    if bytes.len() != 128 {
        return Err(GptgifV4Error::Validation(format!(
            "font file must contain exactly 128 bytes, got {}",
            bytes.len()
        )));
    }
    let mut font = [[0u8; GLYPH_H]; 16];
    for n in 0..16 {
        for y in 0..GLYPH_H {
            font[n][y] = bytes[n * 8 + y];
        }
    }
    Ok(font)
}

pub fn palette_to_bytes(colors: &[GifColor]) -> [u8; 768] {
    let mut out = [0u8; 768];
    for i in 0..NCOLORS.min(colors.len()) {
        out[i * 3] = colors[i].r;
        out[i * 3 + 1] = colors[i].g;
        out[i * 3 + 2] = colors[i].b;
    }
    out
}

pub fn palette_from_bytes(bytes: &[u8]) -> Result<Vec<GifColor>, GptgifV4Error> {
    if bytes.len() != 768 {
        return Err(GptgifV4Error::Validation(format!(
            "palette file must contain exactly 768 bytes, got {}",
            bytes.len()
        )));
    }
    let mut colors = Vec::with_capacity(NCOLORS);
    for i in 0..NCOLORS {
        colors.push(GifColor {
            r: bytes[i * 3],
            g: bytes[i * 3 + 1],
            b: bytes[i * 3 + 2],
        });
    }
    Ok(colors)
}

pub fn default_palette() -> Vec<GifColor> {
    let mut colors = Vec::with_capacity(NCOLORS);
    colors.push(GifColor { r: 5, g: 10, b: 20 });
    for i in 1..NCOLORS {
        if i <= 15 {
            colors.push(GifColor {
                r: (i * 2) as u8,
                g: (i * 2 + 5) as u8,
                b: (i * 3 + 20) as u8,
            });
        } else if i == 31 {
            colors.push(GifColor {
                r: 80,
                g: 90,
                b: 120,
            });
        } else {
            colors.push(GifColor {
                r: (10 + ((i * 2) % 64)) as u8,
                g: (100 + ((i * 3) % 80)) as u8,
                b: (150 + ((i * 5) % 100)) as u8,
            });
        }
    }
    colors
}

fn same_color(a: GifColor, b: GifColor) -> bool {
    a.r == b.r && a.g == b.g && a.b == b.b
}

pub fn validate_palette(colors: &[GifColor]) -> Result<(), GptgifV4Error> {
    for real in 40..=239 {
        for low in 0..=31 {
            if low > 15 && low != 31 {
                continue;
            }
            if same_color(colors[real], colors[low]) {
                return Err(GptgifV4Error::Validation(format!(
                    "foreground color role {real} collides with background/noise/decoy role {low}"
                )));
            }
        }
    }
    Ok(())
}

pub fn random_palette(seed_in: u32) -> Vec<GifColor> {
    let mut seed = if seed_in == 0 { 0xa5a5a5a5 } else { seed_in };
    let mut colors = Vec::with_capacity(NCOLORS);
    for _ in 0..NCOLORS {
        seed = xorshift32(seed);
        colors.push(GifColor {
            r: (seed & 0xff) as u8,
            g: ((seed >> 8) & 0xff) as u8,
            b: ((seed >> 16) & 0xff) as u8,
        });
    }
    for real in 40..=239 {
        loop {
            let mut collision = false;
            for low in 0..=31 {
                if (low <= 15 || low == 31) && same_color(colors[real], colors[low]) {
                    collision = true;
                    break;
                }
            }
            if !collision {
                break;
            }
            seed = xorshift32(seed);
            colors[real] = GifColor {
                r: (seed & 0xff) as u8,
                g: ((seed >> 8) & 0xff) as u8,
                b: ((seed >> 16) & 0xff) as u8,
            };
        }
    }
    colors
}

fn draw_canonical(raster: &mut [u8], cell: usize, nibble: usize, font: &GlyphFont) {
    let base_x = (cell % COLS) * GLYPH_W;
    let base_y = (cell / COLS) * GLYPH_H;
    for y in 0..GLYPH_H {
        for x in 0..GLYPH_W {
            if (font[nibble][y] & (1 << (7 - x))) != 0 {
                raster[(base_y + y) * WIDTH + base_x + x] = 40;
            }
        }
    }
}

fn build_calibration_frame(length: u64, digest: &[u8; 32], font: &GlyphFont) -> Vec<u8> {
    let mut raster = vec![0u8; WIDTH * HEIGHT];
    for role in 0..NCOLORS {
        let base_x = (role % COLS) * GLYPH_W;
        let base_y = (role / COLS) * GLYPH_H;
        for y in 0..GLYPH_H {
            for x in 0..GLYPH_W {
                raster[(base_y + y) * WIDTH + base_x + x] = role as u8;
            }
        }
    }
    for n in 0..16 {
        draw_canonical(&mut raster, LEGEND_START + n, n, font);
    }

    let mut header = [0u8; 48];
    header[0..8].copy_from_slice(MAGIC);
    header[8..16].copy_from_slice(&length.to_le_bytes());
    header[16..48].copy_from_slice(digest);
    for i in 0..48 {
        draw_canonical(&mut raster, 400 + i * 2, (header[i] & 15) as usize, font);
        draw_canonical(&mut raster, 401 + i * 2, (header[i] >> 4) as usize, font);
    }
    raster
}

fn draw_glyph(
    raster: &mut [u8],
    base_x: usize,
    base_y: usize,
    nibble: usize,
    frame: usize,
    seed: u32,
    decoy: bool,
    font: &GlyphFont,
) {
    let rotation = (seed & 3) as usize;
    let mut jx = (((seed >> 2) & 3) as i32) - 1;
    let mut jy = (((seed >> 4) & 3) as i32) - 1;
    if jx > 1 {
        jx = 1;
    }
    if jy > 1 {
        jy = 1;
    }
    let holes = !decoy && ((seed >> 6) & 7) == 0;
    let frame_color = (frame % 200) * 5;
    for y in 0..GLYPH_H {
        for x in 0..GLYPH_W {
            if (font[nibble][y] & (1 << (7 - x))) == 0 {
                continue;
            }
            if holes && ((x + y) % 2 == 1) {
                continue;
            }
            let (u, v) = rotate_pixel(x as i32, y as i32, rotation);
            let cx = u - 4;
            let cy = v - 4;
            let dist = (cx * cx + cy * cy) as usize;
            let role = if decoy {
                31
            } else {
                40 + ((frame_color + dist * 17 + (seed as usize & 127)) % 200) as u8
            };
            let px = (base_x as i32 + u + jx) as usize;
            let py = (base_y as i32 + v + jy) as usize;
            if px < WIDTH && py < HEIGHT {
                raster[py * WIDTH + px] = role;
            }
        }
    }
}

fn physical_cell(permutation: &[i32], logical: usize) -> usize {
    let col = logical / ROWS;
    let row = logical % ROWS;
    let physical_row = if (col & 1) != 0 { ROWS - 1 - row } else { row };
    permutation[col * ROWS + physical_row] as usize
}

fn build_payload_frame(bytes: &[u8], frame: usize, font: &GlyphFont) -> Vec<u8> {
    let mut raster = vec![0u8; WIDTH * HEIGHT];
    let length = bytes.len();
    let nibble_count = length * 2;
    let mut nibbles = vec![0u8; FRAME_CHARS];
    for (i, &b) in bytes.iter().enumerate() {
        let byte = b ^ 0xa5;
        nibbles[2 * i] = byte & 15;
        nibbles[2 * i + 1] = byte >> 4;
    }

    let mut seed_perm = 0xc0ffee00u32
        .wrapping_add((frame as u32).wrapping_mul(0x9e3779b1))
        .wrapping_add(0xdefc0ffe);
    let mut seed_glyph = seed_perm ^ 0x12345678;
    let mut seed_noise = seed_perm ^ 0xa5a5a5a5;

    let mut permutation = vec![0i32; FRAME_CHARS];
    for i in 0..FRAME_CHARS {
        permutation[i] = i as i32;
    }
    for i in (1..FRAME_CHARS).rev() {
        seed_perm = xorshift32(seed_perm);
        let j = (seed_perm as usize) % (i + 1);
        permutation.swap(i, j);
    }

    for _ in 0..((WIDTH * HEIGHT) / 50) {
        seed_noise = xorshift32(seed_noise);
        let pos = (seed_noise as usize) % (WIDTH * HEIGHT);
        if raster[pos] == 0 {
            raster[pos] = (((seed_noise >> 16) % 15) + 1) as u8;
        }
    }

    let mut glyph_seeds = vec![0u32; FRAME_CHARS];
    for seed in glyph_seeds.iter_mut() {
        seed_glyph = xorshift32(seed_glyph);
        *seed = seed_glyph;
    }

    let shift = (((frame & 15) * 7 + 13) & 15) as u8;
    for i in 0..nibble_count {
        let source = if (frame & 1) != 0 { i ^ 1 } else { i };
        let encoded = (nibbles[source].wrapping_add(shift)) & 15;
        let p = physical_cell(&permutation, i);
        draw_glyph(
            &mut raster,
            (p / ROWS) * GLYPH_W,
            (p % ROWS) * GLYPH_H,
            encoded as usize,
            frame,
            glyph_seeds[i],
            false,
            font,
        );
    }

    for i in nibble_count..FRAME_CHARS {
        seed_glyph = xorshift32(seed_glyph);
        if seed_glyph % 100 < 20 {
            let p = physical_cell(&permutation, i);
            draw_glyph(
                &mut raster,
                (p / ROWS) * GLYPH_W,
                (p % ROWS) * GLYPH_H,
                (seed_glyph % 16) as usize,
                frame,
                seed_glyph,
                true,
                font,
            );
        }
    }

    raster
}

#[derive(Debug, Clone, Default)]
pub struct EncodeGptgifV4Options {
    pub font: Option<GlyphFont>,
    pub font_seed: Option<u32>,
    pub palette: Option<Vec<GifColor>>,
    pub palette_seed: Option<u32>,
}

pub fn encode_gptgif_v4(
    inputs: &[&[u8]],
    options: &EncodeGptgifV4Options,
) -> Result<Vec<u8>, GptgifV4Error> {
    let font = options
        .font
        .or_else(|| options.font_seed.map(random_font))
        .unwrap_or(DEFAULT_FONT);
    let palette = options
        .palette
        .clone()
        .or_else(|| options.palette_seed.map(random_palette))
        .unwrap_or_else(default_palette);

    validate_font(&font)?;
    validate_palette(&palette)?;

    let mut payload = Vec::new();
    for &inp in inputs {
        payload.extend_from_slice(inp);
    }

    let mut hasher = Sha256::new();
    hasher.update(&payload);
    let digest: [u8; 32] = hasher.finalize().into();
    let length = payload.len() as u64;

    let mut frames = vec![GifFrame {
        pixels: build_calibration_frame(length, &digest, &font),
        delay_cs: None,
    }];

    let mut remaining = payload.len();
    let mut offset = 0;
    let mut frame = 0;
    while remaining > 0 {
        let take = FRAME_BYTES.min(remaining);
        frames.push(GifFrame {
            pixels: build_payload_frame(&payload[offset..offset + take], frame, &font),
            delay_cs: None,
        });
        offset += take;
        remaining -= take;
        frame += 1;
    }

    Ok(write_gif(&GifImage {
        width: WIDTH as u16,
        height: HEIGHT as u16,
        global_color_table: palette,
        frames,
    }))
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

fn read_cell_mask(
    raster: &[u8],
    cell: usize,
    is_foreground: impl Fn(u8) -> bool,
) -> u64 {
    let base_x = (cell % COLS) * GLYPH_W;
    let base_y = (cell / COLS) * GLYPH_H;
    let mut mask = 0u64;
    for y in 0..GLYPH_H {
        for x in 0..GLYPH_W {
            if is_foreground(raster[(base_y + y) * WIDTH + base_x + x]) {
                mask |= 1u64 << (y * GLYPH_W + x);
            }
        }
    }
    mask
}

struct Calibration {
    templates: Vec<Vec<u64>>,
    style_by_seed: Vec<usize>,
    payload_length: usize,
    payload_digest: [u8; 32],
}

fn learn_templates(canonical: &[u64]) -> Result<(Vec<Vec<u64>>, Vec<usize>), GptgifV4Error> {
    let coordinates: Vec<Vec<(i32, i32)>> = canonical
        .iter()
        .map(|&mask| {
            let mut points = Vec::new();
            for bit in 0..64 {
                if (mask & (1u64 << bit)) != 0 {
                    points.push(((bit % GLYPH_W) as i32, (bit / GLYPH_W) as i32));
                }
            }
            points
        })
        .collect();

    let mut templates: Vec<Vec<u64>> = Vec::new();
    let mut style_index_of: HashMap<(usize, i32, i32, bool), usize> = HashMap::new();

    for rotation in 0..4 {
        for jx in -1..=1 {
            for jy in -1..=1 {
                for &holes in &[false, true] {
                    style_index_of.insert((rotation, jx, jy, holes), templates.len());
                    let mut variants = Vec::new();
                    for glyph in &coordinates {
                        let mut mask = 0u64;
                        for &(x, y) in glyph {
                            if holes && ((x + y) % 2 == 1) {
                                continue;
                            }
                            let (mut u, mut v) = rotate_pixel(x, y, rotation);
                            u += jx;
                            v += jy;
                            if !(0..8).contains(&u) || !(0..8).contains(&v) {
                                return Err(GptgifV4Error::Decode(
                                    "learned alphabet clips under v4 jitter".into(),
                                ));
                            }
                            mask |= 1u64 << (v as usize * 8 + u as usize);
                        }
                        variants.push(mask);
                    }
                    let distinct: HashSet<u64> = variants.iter().copied().collect();
                    if variants.contains(&0) || distinct.len() != 16 {
                        return Err(GptgifV4Error::Decode(
                            "learned alphabet has empty or ambiguous transformed glyphs".into(),
                        ));
                    }
                    templates.push(variants);
                }
            }
        }
    }

    let mut style_by_seed = vec![0usize; 512];
    for seed in 0..512 {
        let rotation = seed & 3;
        let jx = (((seed >> 2) & 3) as i32 - 1).min(1);
        let jy = (((seed >> 4) & 3) as i32 - 1).min(1);
        let holes = ((seed >> 6) & 7) == 0;
        let key = (rotation, jx, jy, holes);
        style_by_seed[seed] = style_index_of[&key];
    }

    Ok((templates, style_by_seed))
}

fn learn_calibration(image: &GifImage) -> Result<Calibration, GptgifV4Error> {
    let raster = &image.frames[0].pixels;

    for role in 0..NCOLORS {
        let base_x = (role % COLS) * GLYPH_W;
        let base_y = (role / COLS) * GLYPH_H;
        let expected = raster[base_y * WIDTH + base_x];
        for y in 0..GLYPH_H {
            for x in 0..GLYPH_W {
                if raster[(base_y + y) * WIDTH + base_x + x] != expected {
                    return Err(GptgifV4Error::Decode(
                        "calibration color swatches must be solid".into(),
                    ));
                }
            }
        }
    }

    let is_foreground_40 = |value: u8| value == 40;
    let mut canonical = Vec::with_capacity(16);
    for n in 0..16 {
        canonical.push(read_cell_mask(raster, LEGEND_START + n, is_foreground_40));
    }
    let (templates, style_by_seed) = learn_templates(&canonical)?;

    let mut header_nibbles = vec![0u8; HEADER_BYTES * 2];
    for i in 0..(HEADER_BYTES * 2) {
        let mask = read_cell_mask(raster, HEADER_START + i, is_foreground_40);
        let nibble = canonical.iter().position(|&m| m == mask).ok_or_else(|| {
            GptgifV4Error::Decode("visual header contains an unknown glyph".into())
        })?;
        header_nibbles[i] = nibble as u8;
    }

    let mut header = [0u8; HEADER_BYTES];
    for i in 0..HEADER_BYTES {
        header[i] = header_nibbles[2 * i] | (header_nibbles[2 * i + 1] << 4);
    }

    if &header[0..8] != MAGIC {
        return Err(GptgifV4Error::Decode("visual header is not gptgif v4".into()));
    }
    let payload_length = u64::from_le_bytes(header[8..16].try_into().unwrap()) as usize;
    let mut payload_digest = [0u8; 32];
    payload_digest.copy_from_slice(&header[16..48]);

    Ok(Calibration {
        templates,
        style_by_seed,
        payload_length,
        payload_digest,
    })
}

fn frame_layout(
    frame_index: usize,
    style_by_seed: &[usize],
    boustrophedon: &[u16; FRAME_CHARS],
) -> (Vec<usize>, Vec<usize>) {
    let initial = 0xc0ffee00u32
        .wrapping_add((frame_index as u32).wrapping_mul(0x9e3779b1))
        .wrapping_add(0xdefc0ffe);
    let mut state = initial;
    let mut permutation = vec![0i32; FRAME_CHARS];
    for i in 0..FRAME_CHARS {
        permutation[i] = i as i32;
    }
    for i in (1..FRAME_CHARS).rev() {
        state = xorshift32(state);
        let j = (state as usize) % (i + 1);
        permutation.swap(i, j);
    }

    state = initial ^ 0x12345678;
    let mut styles = vec![0usize; FRAME_CHARS];
    for s in styles.iter_mut() {
        state = xorshift32(state);
        *s = style_by_seed[(state & 0x1ff) as usize];
    }

    let mut positions = vec![0usize; FRAME_CHARS];
    for logical in 0..FRAME_CHARS {
        positions[logical] = permutation[boustrophedon[logical] as usize] as usize;
    }

    (positions, styles)
}

fn decode_payload_frame(
    raster: &[u8],
    frame_index: usize,
    byte_count: usize,
    calibration: &Calibration,
    boustrophedon: &[u16; FRAME_CHARS],
) -> Result<Vec<u8>, GptgifV4Error> {
    let is_foreground = |value: u8| (40..=239).contains(&value);
    let mut physical_masks = vec![0u64; FRAME_CHARS];
    for cell in 0..FRAME_CHARS {
        let col = cell / ROWS;
        let row = cell % ROWS;
        let base_x = col * GLYPH_W;
        let base_y = row * GLYPH_H;
        let mut mask = 0u64;
        for y in 0..GLYPH_H {
            for x in 0..GLYPH_W {
                if is_foreground(raster[(base_y + y) * WIDTH + base_x + x]) {
                    mask |= 1u64 << (y * GLYPH_W + x);
                }
            }
        }
        physical_masks[cell] = mask;
    }

    let (positions, styles) = frame_layout(frame_index, &calibration.style_by_seed, boustrophedon);
    let length = byte_count * 2;
    let mut observed = vec![0u64; FRAME_CHARS];
    for i in 0..FRAME_CHARS {
        observed[i] = physical_masks[positions[i]];
    }

    for i in 0..length {
        if observed[i] == 0 {
            return Err(GptgifV4Error::Decode(format!(
                "payload frame {frame_index}: cell count disagrees with header length"
            )));
        }
    }
    for i in length..FRAME_CHARS {
        if observed[i] != 0 {
            return Err(GptgifV4Error::Decode(format!(
                "payload frame {frame_index}: cell count disagrees with header length"
            )));
        }
    }

    let mut nibbles = vec![0u8; length];
    for i in 0..length {
        let template = &calibration.templates[styles[i]];
        let nibble = template.iter().position(|&m| m == observed[i]).ok_or_else(|| {
            GptgifV4Error::Decode(format!("payload frame {frame_index}: unknown or ambiguous glyph"))
        })?;
        nibbles[i] = nibble as u8;
    }

    let shift = (((frame_index * 7 + 13) & 15) as u8) & 15;
    for nib in nibbles.iter_mut() {
        *nib = (nib.wrapping_sub(shift)) & 15;
    }
    if (frame_index & 1) != 0 {
        for i in (0..length).step_by(2) {
            nibbles.swap(i, i + 1);
        }
    }

    let mut out = vec![0u8; byte_count];
    for i in 0..byte_count {
        out[i] = (nibbles[2 * i] | (nibbles[2 * i + 1] << 4)) ^ 0xa5;
    }
    Ok(out)
}

/// Decodes a gptgif v4 GIF back to its original bytes.
pub fn decode_gptgif_v4(gif: &[u8]) -> Result<Vec<u8>, GptgifV4Error> {
    let image = read_gif(gif)?;
    if image.width != WIDTH as u16 || image.height != HEIGHT as u16 {
        return Err(GptgifV4Error::Decode(format!(
            "expected a {WIDTH}x{HEIGHT} GIF"
        )));
    }
    if image.frames.is_empty() {
        return Err(GptgifV4Error::Decode(
            "missing v4 calibration frame".into(),
        ));
    }

    let calibration = learn_calibration(&image)?;
    let payload_frame_count = (calibration.payload_length + FRAME_BYTES - 1) / FRAME_BYTES;
    if image.frames.len() != payload_frame_count + 1 {
        return Err(GptgifV4Error::Decode(
            "GIF frame count disagrees with visual header length".into(),
        ));
    }

    let boustrophedon = build_boustrophedon();
    let mut hasher = Sha256::new();
    let mut chunks = Vec::new();
    let mut written = 0;

    for frame_index in 0..payload_frame_count {
        let count = FRAME_BYTES.min(calibration.payload_length - written);
        let decoded = decode_payload_frame(
            &image.frames[frame_index + 1].pixels,
            frame_index,
            count,
            &calibration,
            &boustrophedon,
        )?;
        hasher.update(&decoded);
        written += decoded.len();
        chunks.extend(decoded);
    }

    let digest: [u8; 32] = hasher.finalize().into();
    if digest != calibration.payload_digest {
        return Err(GptgifV4Error::Decode(
            "SHA-256 digest mismatch; no recovered output has been published".into(),
        ));
    }

    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_font_and_palette_validate() {
        validate_font(&DEFAULT_FONT).unwrap();
        validate_palette(&default_palette()).unwrap();
    }

    #[test]
    fn random_font_and_palette_round_trip_bytes() {
        let font = random_font(12345);
        let font_bytes = font_to_bytes(&font);
        let font_back = font_from_bytes(&font_bytes).unwrap();
        assert_eq!(font, font_back);

        let pal = random_palette(67890);
        let pal_bytes = palette_to_bytes(&pal);
        let pal_back = palette_from_bytes(&pal_bytes).unwrap();
        assert_eq!(pal, pal_back);
    }

    #[test]
    fn font_from_bytes_rejects_wrong_length() {
        assert!(matches!(font_from_bytes(&[0u8; 100]), Err(GptgifV4Error::Validation(_))));
        assert!(matches!(palette_from_bytes(&[0u8; 100]), Err(GptgifV4Error::Validation(_))));
    }

    #[test]
    fn encode_decode_v4_round_trip() {
        let input = b"Hello, gptgif v4 world! Testing complete round trip.";
        let gif = encode_gptgif_v4(&[input], &EncodeGptgifV4Options::default()).unwrap();
        let decoded = decode_gptgif_v4(&gif).unwrap();
        assert_eq!(&decoded, input);
    }

    #[test]
    fn encode_decode_v4_with_random_seeds() {
        let input = b"Random seeds test with custom font and palette.";
        let gif = encode_gptgif_v4(
            &[input],
            &EncodeGptgifV4Options {
                font_seed: Some(42),
                palette_seed: Some(99),
                ..Default::default()
            },
        )
        .unwrap();
        let decoded = decode_gptgif_v4(&gif).unwrap();
        assert_eq!(&decoded, input);
    }

    #[test]
    fn decode_v4_rejects_empty_frames() {
        let empty_gif = write_gif(&GifImage {
            width: 640,
            height: 480,
            global_color_table: default_palette(),
            frames: Vec::new(),
        });
        assert!(matches!(decode_gptgif_v4(&empty_gif), Err(GptgifV4Error::Decode(_))));
    }
}
