//! Minimal, dependency-free GIF89a encoder and decoder.
//! Port of `apps/server/src/gif89a.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GifColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GifFrame {
    pub pixels: Vec<u8>,
    pub delay_cs: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GifImage {
    pub width: u16,
    pub height: u16,
    pub global_color_table: Vec<GifColor>,
    pub frames: Vec<GifFrame>,
}

#[derive(Debug, thiserror::Error)]
pub enum GifError {
    #[error("gif: not a GIF file (bad signature)")]
    BadSignature,
    #[error("gif: unexpected block marker 0x{0:x} at offset {1}")]
    UnexpectedMarker(u8, usize),
    #[error("gif: invalid LZW code {0}")]
    InvalidLzwCode(usize),
    #[error("gif: unexpected EOF")]
    UnexpectedEof,
}

const GIF_HEADER: &[u8; 6] = b"GIF89a";

fn next_power_of_two_exponent(n: usize) -> u8 {
    let mut bits = 1u8;
    while (1usize << bits) < n {
        bits += 1;
    }
    bits
}

struct BitWriter {
    bytes: Vec<u8>,
    bit_buffer: u32,
    bit_count: u8,
}

impl BitWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            bit_buffer: 0,
            bit_count: 0,
        }
    }

    fn write_code(&mut self, code: usize, width: u8) {
        self.bit_buffer |= (code as u32) << self.bit_count;
        self.bit_count += width;
        while self.bit_count >= 8 {
            self.bytes.push((self.bit_buffer & 0xff) as u8);
            self.bit_buffer >>= 8;
            self.bit_count -= 8;
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.bit_count > 0 {
            self.bytes.push((self.bit_buffer & 0xff) as u8);
        }
        self.bytes
    }
}

fn lzw_encode(pixels: &[u8], min_code_size: u8) -> Vec<u8> {
    let clear_code = 1usize << min_code_size;
    let end_code = clear_code + 1;
    let max_code_bits = 12u8;
    let max_dict_size = 1usize << max_code_bits;

    let mut writer = BitWriter::new();
    let mut code_size = min_code_size + 1;
    let mut next_code = end_code + 1;

    writer.write_code(clear_code, code_size);

    let mut first_since_reset = true;
    for &pixel in pixels {
        writer.write_code(pixel as usize, code_size);
        if !first_since_reset {
            if next_code < max_dict_size {
                next_code += 1;
                if next_code >= (1usize << code_size) && code_size < max_code_bits {
                    code_size += 1;
                }
            } else {
                writer.write_code(clear_code, code_size);
                next_code = end_code + 1;
                code_size = min_code_size + 1;
                first_since_reset = true;
                continue;
            }
        }
        first_since_reset = false;
    }
    writer.write_code(end_code, code_size);

    writer.finish()
}

struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    bit_buffer: u32,
    bit_count: u8,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            bit_buffer: 0,
            bit_count: 0,
        }
    }

    fn read_code(&mut self, width: u8) -> Option<usize> {
        let mut ran_out_mid_code = false;
        while self.bit_count < width {
            if self.pos >= self.data.len() {
                if self.bit_count == 0 {
                    return None;
                }
                ran_out_mid_code = true;
                break;
            }
            self.bit_buffer |= (self.data[self.pos] as u32) << self.bit_count;
            self.bit_count += 8;
            self.pos += 1;
        }
        let mask = (1u32 << width) - 1;
        let code = (self.bit_buffer & mask) as usize;
        self.bit_buffer >>= width;
        self.bit_count = if ran_out_mid_code {
            0
        } else {
            self.bit_count - width
        };
        Some(code)
    }
}

fn lzw_decode(
    data: &[u8],
    min_code_size: u8,
    expected_pixel_count: usize,
) -> Result<Vec<u8>, GifError> {
    let clear_code = 1usize << min_code_size;
    let end_code = clear_code + 1;
    let max_code_bits = 12u8;
    let max_dict_size = 1usize << max_code_bits;

    let mut reader = BitReader::new(data);
    let mut out = vec![0u8; expected_pixel_count];
    let mut out_pos = 0;

    let mut dict: Vec<Vec<u8>> = Vec::new();
    let mut code_size = min_code_size + 1;
    let mut next_code = end_code + 1;

    let reset_dict = |dict: &mut Vec<Vec<u8>>, code_size: &mut u8, next_code: &mut usize| {
        dict.clear();
        for i in 0..clear_code {
            dict.push(vec![i as u8]);
        }
        dict.push(Vec::new()); // clear code placeholder
        dict.push(Vec::new()); // end code placeholder
        *next_code = end_code + 1;
        *code_size = min_code_size + 1;
    };

    reset_dict(&mut dict, &mut code_size, &mut next_code);
    let mut previous: Option<Vec<u8>> = None;

    while let Some(code) = reader.read_code(code_size) {
        if code == end_code {
            break;
        }
        if code == clear_code {
            reset_dict(&mut dict, &mut code_size, &mut next_code);
            previous = None;
            continue;
        }

        let entry = if code < dict.len() && !dict[code].is_empty() {
            dict[code].clone()
        } else if let Some(ref prev) = previous {
            if code == next_code {
                let mut e = prev.clone();
                e.push(prev[0]);
                e
            } else {
                return Err(GifError::InvalidLzwCode(code));
            }
        } else {
            return Err(GifError::InvalidLzwCode(code));
        };

        for &val in &entry {
            if out_pos < out.len() {
                out[out_pos] = val;
            }
            out_pos += 1;
        }

        if let Some(prev) = previous {
            if next_code < max_dict_size {
                let mut new_entry = prev;
                new_entry.push(entry[0]);
                if next_code < dict.len() {
                    dict[next_code] = new_entry;
                } else {
                    dict.push(new_entry);
                }
                next_code += 1;
                if next_code >= (1usize << code_size) && code_size < max_code_bits {
                    code_size += 1;
                }
            }
        }
        previous = Some(entry);
    }

    Ok(out)
}

fn write_sub_blocks(chunks: &mut Vec<u8>, data: &[u8]) {
    let mut offset = 0;
    while offset < data.len() {
        let size = 255.min(data.len() - offset);
        chunks.push(size as u8);
        chunks.extend_from_slice(&data[offset..offset + size]);
        offset += size;
    }
    chunks.push(0);
}

fn read_sub_blocks(buf: &[u8], offset: usize) -> Result<(Vec<u8>, usize), GifError> {
    let mut parts = Vec::new();
    let mut pos = offset;
    loop {
        if pos >= buf.len() {
            return Err(GifError::UnexpectedEof);
        }
        let size = buf[pos] as usize;
        pos += 1;
        if size == 0 {
            break;
        }
        if pos + size > buf.len() {
            return Err(GifError::UnexpectedEof);
        }
        parts.extend_from_slice(&buf[pos..pos + size]);
        pos += size;
    }
    Ok((parts, pos))
}

/// Encodes a multi-frame indexed-color GIF89a.
pub fn write_gif(image: &GifImage) -> Vec<u8> {
    let mut chunks = Vec::new();
    chunks.extend_from_slice(GIF_HEADER);

    let color_table_size = 2.max(image.global_color_table.len());
    let color_bits = next_power_of_two_exponent(color_table_size);
    let padded_table_size = 1usize << color_bits;

    let mut lsd = [0u8; 7];
    lsd[0..2].copy_from_slice(&image.width.to_le_bytes());
    lsd[2..4].copy_from_slice(&image.height.to_le_bytes());
    lsd[4] = 0x80 | ((color_bits - 1) << 4) | (color_bits - 1);
    lsd[5] = 0; // background color
    lsd[6] = 0; // aspect ratio
    chunks.extend_from_slice(&lsd);

    for i in 0..padded_table_size {
        let color = image
            .global_color_table
            .get(i)
            .copied()
            .unwrap_or(GifColor { r: 0, g: 0, b: 0 });
        chunks.push(color.r);
        chunks.push(color.g);
        chunks.push(color.b);
    }

    // NETSCAPE2.0 looping extension
    chunks.extend_from_slice(&[0x21, 0xff, 0x0b]);
    chunks.extend_from_slice(b"NETSCAPE2.0");
    chunks.extend_from_slice(&[0x03, 0x01, 0x00, 0x00, 0x00]);

    let min_code_size = 2.max(color_bits);

    for frame in &image.frames {
        let mut gce = [0x21, 0xf9, 0x04, 0x00, 0, 0, 0x00, 0x00];
        let delay = frame.delay_cs.unwrap_or(0);
        gce[4..6].copy_from_slice(&delay.to_le_bytes());
        chunks.extend_from_slice(&gce);

        let mut image_desc = [0u8; 10];
        image_desc[0] = 0x2c;
        image_desc[1..3].copy_from_slice(&0u16.to_le_bytes());
        image_desc[3..5].copy_from_slice(&0u16.to_le_bytes());
        image_desc[5..7].copy_from_slice(&image.width.to_le_bytes());
        image_desc[7..9].copy_from_slice(&image.height.to_le_bytes());
        image_desc[9] = 0;
        chunks.extend_from_slice(&image_desc);

        chunks.push(min_code_size);
        let compressed = lzw_encode(&frame.pixels, min_code_size);
        write_sub_blocks(&mut chunks, &compressed);
    }

    chunks.push(0x3b); // trailer

    chunks
}

/// Decodes a GIF89a into its frames (palette indices) and global color table.
pub fn read_gif(buf: &[u8]) -> Result<GifImage, GifError> {
    if buf.len() < 6 || &buf[0..3] != b"GIF" {
        return Err(GifError::BadSignature);
    }

    let width = u16::from_le_bytes(buf[6..8].try_into().unwrap());
    let height = u16::from_le_bytes(buf[8..10].try_into().unwrap());
    let packed = buf[10];
    let has_global_color_table = (packed & 0x80) != 0;
    let color_bits = (packed & 0x07) + 1;
    let color_table_size = if has_global_color_table {
        1usize << color_bits
    } else {
        0
    };

    let mut offset = 13;
    let mut global_color_table = Vec::with_capacity(color_table_size);
    for _ in 0..color_table_size {
        if offset + 3 > buf.len() {
            return Err(GifError::UnexpectedEof);
        }
        global_color_table.push(GifColor {
            r: buf[offset],
            g: buf[offset + 1],
            b: buf[offset + 2],
        });
        offset += 3;
    }

    let mut frames = Vec::new();
    let mut pending_delay: Option<u16> = None;

    while offset < buf.len() {
        let marker = buf[offset];
        if marker == 0x3b {
            break;
        }
        if marker == 0x21 {
            if offset + 2 > buf.len() {
                return Err(GifError::UnexpectedEof);
            }
            let label = buf[offset + 1];
            if label == 0xf9 {
                if offset + 8 > buf.len() {
                    return Err(GifError::UnexpectedEof);
                }
                pending_delay = Some(u16::from_le_bytes(buf[offset + 4..offset + 6].try_into().unwrap()));
                offset += 8;
            } else {
                offset += 2;
                let (_, next_offset) = read_sub_blocks(buf, offset)?;
                offset = next_offset;
            }
            continue;
        }
        if marker == 0x2c {
            if offset + 10 > buf.len() {
                return Err(GifError::UnexpectedEof);
            }
            let img_width = u16::from_le_bytes(buf[offset + 5..offset + 7].try_into().unwrap());
            let img_height = u16::from_le_bytes(buf[offset + 7..offset + 9].try_into().unwrap());
            let img_packed = buf[offset + 9];
            offset += 10;
            let has_local_color_table = (img_packed & 0x80) != 0;
            if has_local_color_table {
                let local_bits = (img_packed & 0x07) + 1;
                offset += (1usize << local_bits) * 3;
            }
            if offset >= buf.len() {
                return Err(GifError::UnexpectedEof);
            }
            let min_code_size = buf[offset];
            offset += 1;
            let (data, next_offset) = read_sub_blocks(buf, offset)?;
            offset = next_offset;
            let pixels = lzw_decode(&data, min_code_size, img_width as usize * img_height as usize)?;
            frames.push(GifFrame {
                pixels,
                delay_cs: pending_delay,
            });
            pending_delay = None;
            continue;
        }

        return Err(GifError::UnexpectedMarker(marker, offset));
    }

    Ok(GifImage {
        width,
        height,
        global_color_table,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack_codes(codes: &[(usize, u8)]) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut bit_buffer = 0u32;
        let mut bit_count = 0u8;
        for &(code, width) in codes {
            bit_buffer |= (code as u32) << bit_count;
            bit_count += width;
            while bit_count >= 8 {
                bytes.push((bit_buffer & 0xff) as u8);
                bit_buffer >>= 8;
                bit_count -= 8;
            }
        }
        if bit_count > 0 {
            bytes.push((bit_buffer & 0xff) as u8);
        }
        bytes
    }

    fn sub_blocks(data: &[u8]) -> Vec<u8> {
        let mut chunks = Vec::new();
        let mut offset = 0;
        while offset < data.len() {
            let size = 255.min(data.len() - offset);
            chunks.push(size as u8);
            chunks.extend_from_slice(&data[offset..offset + size]);
            offset += size;
        }
        chunks.push(0);
        chunks
    }

    fn build_raw_gif(
        width: u16,
        height: u16,
        min_code_size: u8,
        codes: &[(usize, u8)],
        local_colors: Option<(u8, &[u8])>,
    ) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"GIF89a");
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        out.push(0x80); // global table present (2 entries)
        out.push(0);
        out.push(0);
        out.extend_from_slice(&[10, 20, 30, 40, 50, 60]); // 2 colors

        out.push(0x2c);
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&width.to_le_bytes());
        out.extend_from_slice(&height.to_le_bytes());
        if let Some((bits, _)) = local_colors {
            out.push(0x80 | (bits - 1));
        } else {
            out.push(0);
        }
        if let Some((_, bytes)) = local_colors {
            out.extend_from_slice(bytes);
        }
        out.push(min_code_size);
        out.extend_from_slice(&sub_blocks(&pack_codes(codes)));
        out.push(0x3b);
        out
    }

    #[test]
    fn round_trips_single_frame_minimal_palette() {
        let image = GifImage {
            width: 2,
            height: 2,
            global_color_table: vec![GifColor { r: 9, g: 9, b: 9 }],
            frames: vec![GifFrame {
                pixels: vec![0, 0, 0, 0],
                delay_cs: None,
            }],
        };
        let encoded = write_gif(&image);
        let decoded = read_gif(&encoded).unwrap();
        assert_eq!(decoded.width, 2);
        assert_eq!(decoded.height, 2);
        assert_eq!(decoded.global_color_table.len(), 2);
        assert_eq!(decoded.global_color_table[1], GifColor { r: 0, g: 0, b: 0 });
        assert_eq!(decoded.frames[0].pixels, vec![0, 0, 0, 0]);
    }

    #[test]
    fn round_trips_exact_palette() {
        let palette = vec![
            GifColor { r: 1, g: 2, b: 3 },
            GifColor { r: 4, g: 5, b: 6 },
            GifColor { r: 7, g: 8, b: 9 },
            GifColor { r: 10, g: 11, b: 12 },
        ];
        let image = GifImage {
            width: 2,
            height: 2,
            global_color_table: palette.clone(),
            frames: vec![GifFrame {
                pixels: vec![0, 1, 2, 3],
                delay_cs: None,
            }],
        };
        let encoded = write_gif(&image);
        let decoded = read_gif(&encoded).unwrap();
        assert_eq!(decoded.global_color_table, palette);
        assert_eq!(decoded.frames[0].pixels, vec![0, 1, 2, 3]);
    }

    #[test]
    fn round_trips_multiple_frames_with_and_without_delay() {
        let palette = vec![
            GifColor { r: 0, g: 0, b: 0 },
            GifColor { r: 255, g: 255, b: 255 },
        ];
        let image = GifImage {
            width: 2,
            height: 1,
            global_color_table: palette,
            frames: vec![
                GifFrame {
                    pixels: vec![0, 1],
                    delay_cs: Some(50),
                },
                GifFrame {
                    pixels: vec![1, 0],
                    delay_cs: None,
                },
            ],
        };
        let encoded = write_gif(&image);
        let decoded = read_gif(&encoded).unwrap();
        assert_eq!(decoded.frames.len(), 2);
        assert_eq!(decoded.frames[0].delay_cs, Some(50));
        assert_eq!(decoded.frames[1].delay_cs, Some(0));
        assert_eq!(decoded.frames[0].pixels, vec![0, 1]);
        assert_eq!(decoded.frames[1].pixels, vec![1, 0]);
    }

    #[test]
    fn round_trips_large_frame_mid_stream_reset() {
        let width = 90u16;
        let height = 90u16;
        let mut palette = Vec::new();
        for i in 0..256 {
            palette.push(GifColor {
                r: ((i * 37) & 255) as u8,
                g: ((i * 59) & 255) as u8,
                b: ((i * 97) & 255) as u8,
            });
        }
        let mut pixels = vec![0u8; width as usize * height as usize];
        for i in 0..pixels.len() {
            pixels[i] = ((i * 31 + 7) & 255) as u8;
        }
        let image = GifImage {
            width,
            height,
            global_color_table: palette,
            frames: vec![GifFrame {
                pixels: pixels.clone(),
                delay_cs: None,
            }],
        };
        let encoded = write_gif(&image);
        let decoded = read_gif(&encoded).unwrap();
        assert_eq!(decoded.global_color_table.len(), 256);
        assert_eq!(decoded.frames[0].pixels, pixels);
    }

    #[test]
    fn rejects_not_a_gif() {
        assert!(matches!(read_gif(b"not a gif"), Err(GifError::BadSignature)));
    }

    #[test]
    fn decodes_file_with_no_global_color_table() {
        let mut raw = Vec::new();
        raw.extend_from_slice(b"GIF89a");
        raw.extend_from_slice(&3u16.to_le_bytes());
        raw.extend_from_slice(&1u16.to_le_bytes());
        raw.push(0x00); // no global color table
        raw.push(0);
        raw.push(0);

        raw.push(0x2c);
        raw.extend_from_slice(&0u16.to_le_bytes());
        raw.extend_from_slice(&0u16.to_le_bytes());
        raw.extend_from_slice(&3u16.to_le_bytes());
        raw.extend_from_slice(&1u16.to_le_bytes());
        raw.push(0);

        raw.push(2); // minCodeSize
        raw.extend_from_slice(&sub_blocks(&pack_codes(&[
            (4, 3),
            (0, 3),
            (1, 3),
            (5, 3),
        ])));
        raw.push(0x3b);

        let decoded = read_gif(&raw).unwrap();
        assert!(decoded.global_color_table.is_empty());
        assert_eq!(decoded.frames[0].pixels, vec![0, 1, 0]);
    }

    #[test]
    fn skips_local_color_table() {
        let local_bytes = [1u8; 12];
        let raw = build_raw_gif(3, 1, 2, &[(4, 3), (0, 3), (1, 3), (5, 3)], Some((2, &local_bytes)));
        let decoded = read_gif(&raw).unwrap();
        assert_eq!(decoded.global_color_table.len(), 2);
        assert_eq!(decoded.frames[0].pixels, vec![0, 1, 0]);
    }

    #[test]
    fn throws_on_unexpected_marker() {
        let mut raw = build_raw_gif(1, 1, 2, &[(4, 3), (0, 3), (5, 3)], None);
        let trailer_idx = raw.len() - 1;
        raw[trailer_idx] = 0x99;
        assert!(matches!(read_gif(&raw), Err(GifError::UnexpectedMarker(0x99, _))));
    }

    #[test]
    fn decodes_kwkwk_case() {
        let raw = build_raw_gif(3, 1, 2, &[(4, 3), (0, 3), (6, 3), (5, 3)], None);
        let decoded = read_gif(&raw).unwrap();
        assert_eq!(decoded.frames[0].pixels, vec![0, 0, 0]);
    }

    #[test]
    fn kwkwk_overflow_truncates_cleanly() {
        let raw = build_raw_gif(1, 1, 2, &[(4, 3), (0, 3), (6, 3), (5, 3)], None);
        let decoded = read_gif(&raw).unwrap();
        assert_eq!(decoded.frames[0].pixels.len(), 1);
        assert_eq!(decoded.frames[0].pixels, vec![0]);
    }

    #[test]
    fn invalid_lzw_code_throws() {
        let raw = build_raw_gif(1, 1, 2, &[(4, 3), (7, 3)], None);
        assert!(matches!(read_gif(&raw), Err(GifError::InvalidLzwCode(7))));
    }

    #[test]
    fn stream_ending_immediately_after_clear_code() {
        let raw = build_raw_gif(2, 1, 7, &[(128, 8)], None);
        let decoded = read_gif(&raw).unwrap();
        assert_eq!(decoded.frames[0].pixels, vec![0, 0]);
    }

    #[test]
    fn stream_running_out_with_partial_byte() {
        let raw = build_raw_gif(2, 1, 2, &[(4, 3), (0, 3)], None);
        let decoded = read_gif(&raw).unwrap();
        assert_eq!(decoded.frames[0].pixels, vec![0, 0]);
    }
}
