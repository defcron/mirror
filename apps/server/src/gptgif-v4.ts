// gptgif v4: a self-calibrating steganographic format where the visual
// alphabet, color roles, and header are all learned from frame zero of the
// GIF itself, rather than hard-coded in the decoder. Native TS port of
// gptgif-v4.c (encoder, giflib) and gptungif-v4.py (decoder, PIL/numpy),
// both read in full from the gptgif-next branch. See GPTGIF-V4.md for the
// complete wire format this implements.
//
// One simplification from the Python reference, documented where it
// matters: gptungif-v4.py deliberately classifies pixels by their *observed
// RGB color* rather than by GIF palette index (its own comment: "Never
// re-quantize RGB into P"), because a real-world GIF might pass through a
// tool that reorders or re-quantizes the palette before Python ever sees it.
// This module both encodes and decodes its own files via gif89a.ts, which
// round-trips palette indices exactly (verified), so there is no such
// reordering to defend against here -- classifying by the index value
// directly (the same bands the encoder itself paints: 0 background, 1-15
// noise, 31 decoy, 40-239 foreground) is equivalent for every file this
// module produces, and is far simpler than reconstructing an RGB->class
// lookup table. The wire format's actual security/robustness property --
// SHA-256 + length validation before any output is trusted -- is preserved
// exactly, byte for byte.
import { createHash } from "node:crypto";
import { type GifColor, type GifImage, readGif, writeGif } from "./gif89a.js";
import { FONT as DEFAULT_FONT } from "./gptgif.js";

const WIDTH = 640;
const HEIGHT = 480;
const GLYPH_W = 8;
const GLYPH_H = 8;
const COLS = WIDTH / GLYPH_W; // 80
const ROWS = HEIGHT / GLYPH_H; // 60
const FRAME_CHARS = COLS * ROWS; // 4800
const FRAME_BYTES = FRAME_CHARS / 2; // 2400
const NCOLORS = 256;
const LEGEND_START = 320;
const HEADER_START = 400;
const HEADER_BYTES = 48;
const MAGIC = Buffer.from("GPTGIF4\0", "ascii");
const MASK32 = 0xffffffff;

export type GlyphFont = readonly (readonly number[])[];

// gptungif-v4.py's BOUSTROPHEDON: logical slot i (0..FRAME_CHARS-1) walks
// column-major down, then back up the next column, etc. -- matching
// gptgif-v4.c's `physical_cell()`, which reverses the row within odd columns.
function buildBoustrophedon(): Uint16Array {
  const table = new Uint16Array(FRAME_CHARS);
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < ROWS; row++) {
      const logical = col * ROWS + row;
      const physicalRow = col & 1 ? ROWS - 1 - row : row;
      table[logical] = col * ROWS + physicalRow;
    }
  }
  return table;
}
const BOUSTROPHEDON = buildBoustrophedon();

function xorshift32(state: number): number {
  let x = state >>> 0;
  x ^= (x << 13) >>> 0;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}

function rotatePixel(x: number, y: number, rotation: number): [number, number] {
  switch (rotation) {
    case 0:
      return [x, y];
    case 1:
      return [7 - y, x];
    case 2:
      return [7 - x, 7 - y];
    default:
      return [y, 7 - x];
  }
}

/** Verbatim port of gptgif-v4.c's validate_font(): checked before any output is written. */
export function validateFont(font: GlyphFont): void {
  for (let rot = 0; rot < 4; rot++) {
    for (let jx = -1; jx <= 1; jx++) {
      for (let jy = -1; jy <= 1; jy++) {
        for (let holesFlag = 0; holesFlag <= 1; holesFlag++) {
          const holes = holesFlag === 1;
          const masks: bigint[] = [];
          for (let n = 0; n < 16; n++) {
            let mask = 0n;
            for (let y = 0; y < GLYPH_H; y++) {
              for (let x = 0; x < GLYPH_W; x++) {
                if (!(font[n][y] & (1 << (7 - x)))) continue;
                if (holes && (x + y) % 2 === 1) continue;
                let [u, v] = rotatePixel(x, y, rot);
                u += jx;
                v += jy;
                if (u < 0 || u >= GLYPH_W || v < 0 || v >= GLYPH_H) {
                  throw new Error(`gptgif-v4: font glyph ${n.toString(16)} escapes its cell under jitter`);
                }
                mask |= 1n << BigInt(v * GLYPH_W + u);
              }
            }
            if (mask === 0n) {
              throw new Error(`gptgif-v4: font glyph ${n.toString(16)} disappears under an allowed transform`);
            }
            for (let other = 0; other < n; other++) {
              if (masks[other] === mask) {
                throw new Error(
                  `gptgif-v4: font glyphs ${other.toString(16)} and ${n.toString(16)} collide under an allowed transform`,
                );
              }
            }
            masks[n] = mask;
          }
        }
      }
    }
  }
}

const MARKER_X = [1, 2, 3, 4];
const MARKER_Y = [1, 2, 3, 4];
const FIXED_X = 5;
const FIXED_Y = 5;

/** Verbatim port of gptgif-v4.c's random_font(). */
export function randomFont(seedIn: number): GlyphFont {
  let seed = seedIn >>> 0;
  if (seed === 0) seed = 0x6d2b79f5;
  const font: number[][] = Array.from({ length: 16 }, () => new Array(GLYPH_H).fill(0));
  for (let nibble = 0; nibble < 16; nibble++) {
    for (let y = 1; y <= 6; y++) {
      for (let x = 1; x <= 6; x++) {
        let reserved = x === FIXED_X && y === FIXED_Y;
        for (let bit = 0; bit < 4; bit++) {
          if (x === MARKER_X[bit] && y === MARKER_Y[bit]) reserved = true;
        }
        seed = xorshift32(seed);
        if (!reserved && seed & 1) font[nibble][y] |= 1 << (7 - x);
      }
    }
    font[nibble][FIXED_Y] |= 1 << (7 - FIXED_X);
    for (let bit = 0; bit < 4; bit++) {
      if (nibble & (1 << bit)) font[nibble][MARKER_Y[bit]] |= 1 << (7 - MARKER_X[bit]);
    }
  }
  return font;
}

/**
 * Serializes a font to gptgif-v4.c's `--font FILE` binary format: 16 glyphs
 * x 8 bytes/glyph (one byte per row, exactly what `load_exact_file` checks
 * is 128 bytes long), the same layout {@link randomFont} and `DEFAULT_FONT`
 * already use in memory -- so this is just a flat copy, not a transform.
 */
export function fontToBytes(font: GlyphFont): Buffer {
  const out = Buffer.alloc(128);
  for (let n = 0; n < 16; n++) for (let y = 0; y < GLYPH_H; y++) out[n * 8 + y] = font[n][y];
  return out;
}

/** Parses gptgif-v4.c's `--font FILE` binary format back into a {@link GlyphFont}. Throws on anything but exactly 128 bytes, matching `load_exact_file`'s own exact-length check. */
export function fontFromBytes(bytes: Buffer): GlyphFont {
  if (bytes.length !== 128) throw new Error(`gptgif-v4: font file must contain exactly 128 bytes, got ${bytes.length}`);
  return Array.from({ length: 16 }, (_, n) => Array.from({ length: GLYPH_H }, (_, y) => bytes[n * 8 + y]));
}

/**
 * Serializes a palette to gptgif-v4.c's `--palette FILE` binary format: 256
 * roles x 3 bytes (R,G,B), matching `load_exact_file`'s 768-byte check.
 */
export function paletteToBytes(colors: readonly GifColor[]): Buffer {
  const out = Buffer.alloc(768);
  for (let i = 0; i < NCOLORS; i++) {
    out[i * 3] = colors[i].r;
    out[i * 3 + 1] = colors[i].g;
    out[i * 3 + 2] = colors[i].b;
  }
  return out;
}

/** Parses gptgif-v4.c's `--palette FILE` binary format back into a color array. Throws on anything but exactly 768 bytes, matching `load_exact_file`'s own exact-length check. */
export function paletteFromBytes(bytes: Buffer): GifColor[] {
  if (bytes.length !== 768) throw new Error(`gptgif-v4: palette file must contain exactly 768 bytes, got ${bytes.length}`);
  return Array.from({ length: NCOLORS }, (_, i) => ({ r: bytes[i * 3], g: bytes[i * 3 + 1], b: bytes[i * 3 + 2] }));
}

/** Verbatim port of gptgif-v4.c's default_palette(). */
export function defaultPalette(): GifColor[] {
  const colors: GifColor[] = new Array(NCOLORS);
  colors[0] = { r: 5, g: 10, b: 20 };
  for (let i = 1; i < NCOLORS; i++) {
    if (i <= 15) {
      colors[i] = { r: i * 2, g: i * 2 + 5, b: i * 3 + 20 };
    } else if (i === 31) {
      colors[i] = { r: 80, g: 90, b: 120 };
    } else {
      colors[i] = { r: 10 + ((i * 2) % 64), g: 100 + ((i * 3) % 80), b: 150 + ((i * 5) % 100) };
    }
  }
  return colors;
}

function sameColor(a: GifColor, b: GifColor): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** Verbatim port of gptgif-v4.c's validate_palette(). */
export function validatePalette(colors: readonly GifColor[]): void {
  for (let real = 40; real <= 239; real++) {
    for (let low = 0; low <= 31; low++) {
      if (low > 15 && low !== 31) continue;
      if (sameColor(colors[real], colors[low])) {
        throw new Error(
          `gptgif-v4: foreground color role ${real} collides with background/noise/decoy role ${low}`,
        );
      }
    }
  }
}

/** Verbatim port of gptgif-v4.c's random_palette(), including its reroll loop. */
export function randomPalette(seedIn: number): GifColor[] {
  let seed = seedIn >>> 0;
  if (seed === 0) seed = 0xa5a5a5a5;
  const colors: GifColor[] = new Array(NCOLORS);
  for (let i = 0; i < NCOLORS; i++) {
    seed = xorshift32(seed);
    colors[i] = { r: seed & 0xff, g: (seed >>> 8) & 0xff, b: (seed >>> 16) & 0xff };
  }
  for (let real = 40; real <= 239; real++) {
    for (;;) {
      let collision = false;
      for (let low = 0; low <= 31; low++) {
        if (low <= 15 || low === 31) {
          if (sameColor(colors[real], colors[low])) {
            collision = true;
            break;
          }
        }
      }
      if (!collision) break;
      seed = xorshift32(seed);
      colors[real] = { r: seed & 0xff, g: (seed >>> 8) & 0xff, b: (seed >>> 16) & 0xff };
    }
  }
  return colors;
}

function drawCanonical(raster: Uint8Array, cell: number, nibble: number, font: GlyphFont): void {
  const baseX = (cell % COLS) * GLYPH_W;
  const baseY = Math.floor(cell / COLS) * GLYPH_H;
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (font[nibble][y] & (1 << (7 - x))) raster[(baseY + y) * WIDTH + baseX + x] = 40;
    }
  }
}

/** Verbatim port of gptgif-v4.c's calibration_frame(). */
function buildCalibrationFrame(length: bigint, digest: Buffer, font: GlyphFont): Uint8Array {
  const raster = new Uint8Array(WIDTH * HEIGHT);
  for (let role = 0; role < NCOLORS; role++) {
    const baseX = (role % COLS) * GLYPH_W;
    const baseY = Math.floor(role / COLS) * GLYPH_H;
    for (let y = 0; y < GLYPH_H; y++) raster.fill(role, (baseY + y) * WIDTH + baseX, (baseY + y) * WIDTH + baseX + GLYPH_W);
  }
  for (let n = 0; n < 16; n++) drawCanonical(raster, 320 + n, n, font);

  const header = Buffer.alloc(48);
  MAGIC.copy(header, 0);
  header.writeBigUInt64LE(length, 8);
  digest.copy(header, 16);
  for (let i = 0; i < 48; i++) {
    drawCanonical(raster, 400 + i * 2, header[i] & 15, font);
    drawCanonical(raster, 401 + i * 2, header[i] >> 4, font);
  }
  return raster;
}

function drawGlyph(
  raster: Uint8Array,
  baseX: number,
  baseY: number,
  nibble: number,
  frame: number,
  seed: number,
  decoy: boolean,
  font: GlyphFont,
): void {
  const rotation = seed & 3;
  let jx = ((seed >>> 2) & 3) - 1;
  let jy = ((seed >>> 4) & 3) - 1;
  if (jx > 1) jx = 1;
  if (jy > 1) jy = 1;
  const holes = !decoy && ((seed >>> 6) & 7) === 0;
  const frameColor = (frame % 200) * 5;
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (!(font[nibble][y] & (1 << (7 - x)))) continue;
      if (holes && (x + y) % 2 === 1) continue;
      const [u, v] = rotatePixel(x, y, rotation);
      const cx = u - 4;
      const cy = v - 4;
      const dist = cx * cx + cy * cy;
      const role = decoy ? 31 : 40 + ((frameColor + dist * 17 + (seed & 127)) % 200);
      raster[(baseY + v + jy) * WIDTH + (baseX + u + jx)] = role;
    }
  }
}

/** Column-major physical cell numbering used by payload frames (see module doc). */
function physicalCell(permutation: Int32Array, logical: number): number {
  const col = Math.floor(logical / ROWS);
  const row = logical % ROWS;
  const physicalRow = col & 1 ? ROWS - 1 - row : row;
  return permutation[col * ROWS + physicalRow];
}

/** Verbatim port of gptgif-v4.c's payload_frame(). */
function buildPayloadFrame(bytes: Buffer, frame: number, font: GlyphFont): Uint8Array {
  const raster = new Uint8Array(WIDTH * HEIGHT);
  const length = bytes.length;
  const nibbleCount = length * 2;
  const nibbles = new Uint8Array(FRAME_CHARS);
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ^ 0xa5;
    nibbles[2 * i] = byte & 15;
    nibbles[2 * i + 1] = byte >> 4;
  }

  let seedPerm = (0xc0ffee00 + frame * 0x9e3779b1 + 0xdefc0ffe) >>> 0;
  let seedGlyph = (seedPerm ^ 0x12345678) >>> 0;
  let seedNoise = (seedPerm ^ 0xa5a5a5a5) >>> 0;

  const permutation = new Int32Array(FRAME_CHARS);
  for (let i = 0; i < FRAME_CHARS; i++) permutation[i] = i;
  for (let i = FRAME_CHARS - 1; i > 0; i--) {
    seedPerm = xorshift32(seedPerm);
    const j = seedPerm % (i + 1);
    const tmp = permutation[i];
    permutation[i] = permutation[j];
    permutation[j] = tmp;
  }

  for (let k = 0; k < (WIDTH * HEIGHT) / 50; k++) {
    seedNoise = xorshift32(seedNoise);
    const position = seedNoise % (WIDTH * HEIGHT);
    if (raster[position] === 0) raster[position] = ((seedNoise >>> 16) % 15) + 1;
  }

  const glyphSeeds = new Uint32Array(FRAME_CHARS);
  for (let i = 0; i < FRAME_CHARS; i++) {
    seedGlyph = xorshift32(seedGlyph);
    glyphSeeds[i] = seedGlyph;
  }

  const shift = (((frame & 15) * 7 + 13) & 15) >>> 0;
  for (let i = 0; i < nibbleCount; i++) {
    const source = frame & 1 ? i ^ 1 : i;
    const encoded = (nibbles[source] + shift) & 15;
    const p = physicalCell(permutation, i);
    drawGlyph(raster, Math.floor(p / ROWS) * GLYPH_W, (p % ROWS) * GLYPH_H, encoded, frame, glyphSeeds[i], false, font);
  }
  for (let i = nibbleCount; i < FRAME_CHARS; i++) {
    seedGlyph = xorshift32(seedGlyph);
    if (seedGlyph % 100 < 20) {
      const p = physicalCell(permutation, i);
      drawGlyph(
        raster,
        Math.floor(p / ROWS) * GLYPH_W,
        (p % ROWS) * GLYPH_H,
        seedGlyph % 16,
        frame,
        seedGlyph,
        true,
        font,
      );
    }
  }
  return raster;
}

export interface EncodeGptgifV4Options {
  font?: GlyphFont;
  fontSeed?: number;
  palette?: GifColor[];
  paletteSeed?: number;
}

/**
 * Encodes one or more input buffers as a gptgif v4 GIF.
 *
 * With no font/palette options, uses gptgif-v4.c's built-in default font and
 * default_palette() -- matching the C tool's behavior when it *isn't* asked
 * to generate a fresh random seed (the CLI's own default is actually to
 * generate a random seed every run; this module instead defaults to the
 * fixed built-ins, since a deterministic default is more useful for a
 * library API -- pass `fontSeed`/`paletteSeed` explicitly for randomized
 * alphabets, matching `--font-seed`/`--palette-seed`).
 */
export function encodeGptgifV4(inputs: Buffer[], options: EncodeGptgifV4Options = {}): Buffer {
  const font = options.font ?? (options.fontSeed !== undefined ? randomFont(options.fontSeed) : DEFAULT_FONT);
  const palette = options.palette ?? (options.paletteSeed !== undefined ? randomPalette(options.paletteSeed) : defaultPalette());
  validateFont(font);
  validatePalette(palette);

  const payload = Buffer.concat(inputs);
  const digest = createHash("sha256").update(payload).digest();
  const length = BigInt(payload.length);

  const frames: { pixels: Uint8Array; delayCs?: number }[] = [
    { pixels: buildCalibrationFrame(length, digest, font) },
  ];
  let remaining = payload.length;
  let offset = 0;
  let frame = 0;
  while (remaining > 0) {
    const take = Math.min(FRAME_BYTES, remaining);
    frames.push({ pixels: buildPayloadFrame(payload.subarray(offset, offset + take), frame, font) });
    offset += take;
    remaining -= take;
    frame++;
  }

  return writeGif({ width: WIDTH, height: HEIGHT, globalColorTable: palette, frames });
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

function readCellMask(raster: Uint8Array, cell: number, isForeground: (value: number) => boolean): bigint {
  const baseX = (cell % COLS) * GLYPH_W;
  const baseY = Math.floor(cell / COLS) * GLYPH_H;
  let mask = 0n;
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      if (isForeground(raster[(baseY + y) * WIDTH + baseX + x])) mask |= 1n << BigInt(y * GLYPH_W + x);
    }
  }
  return mask;
}

interface Calibration {
  /** templates[styleIndex][nibble] = expected mask for that nibble under that transform style. */
  templates: bigint[][];
  styleBySeed: Uint8Array;
  payloadLength: number;
  payloadDigest: Buffer;
}

/** Verbatim port of gptungif-v4.py's learn_templates(), enumerated in the identical order. */
function learnTemplates(canonical: bigint[]): { templates: bigint[][]; styleBySeed: Uint8Array } {
  const coordinates: [number, number][][] = canonical.map((mask) => {
    const points: [number, number][] = [];
    for (let bit = 0; bit < 64; bit++) {
      if (mask & (1n << BigInt(bit))) points.push([bit % GLYPH_W, Math.floor(bit / GLYPH_W)]);
    }
    return points;
  });

  const templates: bigint[][] = [];
  const styleIndexOf = new Map<string, number>();
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let jx = -1; jx <= 1; jx++) {
      for (let jy = -1; jy <= 1; jy++) {
        for (const holes of [false, true]) {
          styleIndexOf.set(`${rotation},${jx},${jy},${holes}`, templates.length);
          const variants: bigint[] = [];
          for (const glyph of coordinates) {
            let mask = 0n;
            for (const [x, y] of glyph) {
              if (holes && (x + y) % 2 === 1) continue;
              let u: number, v: number;
              if (rotation === 0) [u, v] = [x, y];
              else if (rotation === 1) [u, v] = [7 - y, x];
              else if (rotation === 2) [u, v] = [7 - x, 7 - y];
              else [u, v] = [y, 7 - x];
              u += jx;
              v += jy;
              if (u < 0 || u >= 8 || v < 0 || v >= 8) {
                throw new Error("gptungif-v4: learned alphabet clips under v4 jitter");
              }
              mask |= 1n << BigInt(v * 8 + u);
            }
            variants.push(mask);
          }
          const distinct = new Set(variants.map((m) => m.toString()));
          if (variants.some((m) => m === 0n) || distinct.size !== 16) {
            throw new Error("gptungif-v4: learned alphabet has empty or ambiguous transformed glyphs");
          }
          templates.push(variants);
        }
      }
    }
  }

  const styleBySeed = new Uint8Array(512);
  for (let seed = 0; seed < 512; seed++) {
    const rotation = seed & 3;
    const jx = Math.min(((seed >>> 2) & 3) - 1, 1);
    const jy = Math.min(((seed >>> 4) & 3) - 1, 1);
    const holes = ((seed >>> 6) & 7) === 0;
    const key = `${rotation},${jx},${jy},${holes}`;
    // styleIndexOf was populated by enumerating this exact same
    // rotation/jx/jy/holes domain above (4 x 3 x 3 x 2 = 72 combinations),
    // so every key built here is guaranteed present -- an undefined lookup
    // would be untestable dead code, not a real defense against bad input.
    styleBySeed[seed] = styleIndexOf.get(key)!;
  }
  return { templates, styleBySeed };
}

/** Verbatim port of gptungif-v4.py's learn_calibration(), working from palette indices (see module doc). */
function learnCalibration(image: GifImage): Calibration {
  // decodeGptgifV4, this function's only caller, already rejects an empty
  // `frames` array before calling here, so `image.frames[0]` is always a
  // real frame -- a defensive re-check here would be untestable dead code.
  const raster = image.frames[0].pixels;

  // Swatch cells 0-255 should each be one solid role/index value.
  for (let role = 0; role < NCOLORS; role++) {
    const baseX = (role % COLS) * GLYPH_W;
    const baseY = Math.floor(role / COLS) * GLYPH_H;
    const expected = raster[baseY * WIDTH + baseX];
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (raster[(baseY + y) * WIDTH + baseX + x] !== expected) {
          throw new Error("gptungif-v4: calibration color swatches must be solid");
        }
      }
    }
  }

  const isForeground40 = (value: number) => value === 40;
  const canonical: bigint[] = [];
  for (let n = 0; n < 16; n++) canonical.push(readCellMask(raster, LEGEND_START + n, isForeground40));
  const { templates, styleBySeed } = learnTemplates(canonical);

  const headerNibbles = new Uint8Array(HEADER_BYTES * 2);
  for (let i = 0; i < HEADER_BYTES * 2; i++) {
    const mask = readCellMask(raster, HEADER_START + i, isForeground40);
    const nibble = canonical.indexOf(mask);
    if (nibble < 0) throw new Error("gptungif-v4: visual header contains an unknown glyph");
    headerNibbles[i] = nibble;
  }
  const header = Buffer.alloc(HEADER_BYTES);
  for (let i = 0; i < HEADER_BYTES; i++) header[i] = headerNibbles[2 * i] | (headerNibbles[2 * i + 1] << 4);
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("gptungif-v4: visual header is not gptgif v4");
  const payloadLength = Number(header.readBigUInt64LE(8));
  const payloadDigest = header.subarray(16, 48);

  return { templates, styleBySeed, payloadLength, payloadDigest: Buffer.from(payloadDigest) };
}

function frameLayout(frameIndex: number, styleBySeed: Uint8Array): { positions: Uint16Array; styles: Uint8Array } {
  const initial = (0xc0ffee00 + frameIndex * 0x9e3779b1 + 0xdefc0ffe) >>> 0;
  let state = initial;
  const permutation = new Int32Array(FRAME_CHARS);
  for (let i = 0; i < FRAME_CHARS; i++) permutation[i] = i;
  for (let i = FRAME_CHARS - 1; i > 0; i--) {
    state = xorshift32(state);
    const j = state % (i + 1);
    const tmp = permutation[i];
    permutation[i] = permutation[j];
    permutation[j] = tmp;
  }

  state = (initial ^ 0x12345678) >>> 0;
  const styles = new Uint8Array(FRAME_CHARS);
  for (let i = 0; i < FRAME_CHARS; i++) {
    state = xorshift32(state);
    styles[i] = styleBySeed[state & 0x1ff];
  }

  const positions = new Uint16Array(FRAME_CHARS);
  for (let logical = 0; logical < FRAME_CHARS; logical++) positions[logical] = permutation[BOUSTROPHEDON[logical]];
  return { positions, styles };
}

function decodePayloadFrame(raster: Uint8Array, frameIndex: number, byteCount: number, calibration: Calibration): Buffer {
  const isForeground = (value: number) => value >= 40 && value <= 239;
  // Physical cells are column-major here (col*ROWS+row), unlike calibration's
  // row-major legend/header addressing -- see module doc.
  const physicalMasks = new Array<bigint>(FRAME_CHARS);
  for (let cell = 0; cell < FRAME_CHARS; cell++) {
    const col = Math.floor(cell / ROWS);
    const row = cell % ROWS;
    const baseX = col * GLYPH_W;
    const baseY = row * GLYPH_H;
    let mask = 0n;
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (isForeground(raster[(baseY + y) * WIDTH + baseX + x])) mask |= 1n << BigInt(y * GLYPH_W + x);
      }
    }
    physicalMasks[cell] = mask;
  }

  const { positions, styles } = frameLayout(frameIndex, calibration.styleBySeed);
  const length = byteCount * 2;
  const observed = new Array<bigint>(FRAME_CHARS);
  for (let i = 0; i < FRAME_CHARS; i++) observed[i] = physicalMasks[positions[i]];

  for (let i = 0; i < length; i++) {
    if (observed[i] === 0n) throw new Error(`gptungif-v4: payload frame ${frameIndex}: cell count disagrees with header length`);
  }
  for (let i = length; i < FRAME_CHARS; i++) {
    if (observed[i] !== 0n) throw new Error(`gptungif-v4: payload frame ${frameIndex}: cell count disagrees with header length`);
  }

  const nibbles = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const template = calibration.templates[styles[i]];
    const nibble = template.indexOf(observed[i]);
    if (nibble < 0) throw new Error(`gptungif-v4: payload frame ${frameIndex}: unknown or ambiguous glyph`);
    nibbles[i] = nibble;
  }

  const shift = ((frameIndex * 7 + 13) & 15) >>> 0;
  for (let i = 0; i < length; i++) nibbles[i] = (nibbles[i] - shift) & 15;
  if (frameIndex & 1) {
    for (let i = 0; i < length; i += 2) {
      const tmp = nibbles[i];
      nibbles[i] = nibbles[i + 1];
      nibbles[i + 1] = tmp;
    }
  }

  const out = Buffer.alloc(byteCount);
  for (let i = 0; i < byteCount; i++) out[i] = (nibbles[2 * i] | (nibbles[2 * i + 1] << 4)) ^ 0xa5;
  return out;
}

/**
 * Decodes a gptgif v4 GIF back to its original bytes.
 *
 * Unlike the original/master format's decoder, v4's real Python reference
 * has no bash-pipeline quirk: it writes the verified bytes straight out, and
 * so does this. The full SHA-256 + length + structural validation the format
 * specifies runs before anything is returned; any failure throws rather than
 * emitting a partially-verified result.
 */
export function decodeGptgifV4(gif: Buffer): Buffer {
  const image = readGif(gif);
  if (image.width !== WIDTH || image.height !== HEIGHT) {
    throw new Error(`gptungif-v4: expected a ${WIDTH}x${HEIGHT} GIF`);
  }
  if (image.frames.length === 0) throw new Error("gptungif-v4: missing v4 calibration frame");

  const calibration = learnCalibration(image);
  const payloadFrameCount = Math.ceil(calibration.payloadLength / FRAME_BYTES);
  if (image.frames.length !== payloadFrameCount + 1) {
    throw new Error("gptungif-v4: GIF frame count disagrees with visual header length");
  }

  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let written = 0;
  for (let frameIndex = 0; frameIndex < payloadFrameCount; frameIndex++) {
    const count = Math.min(FRAME_BYTES, calibration.payloadLength - written);
    const decoded = decodePayloadFrame(image.frames[frameIndex + 1].pixels, frameIndex, count, calibration);
    chunks.push(decoded);
    hash.update(decoded);
    written += decoded.length;
  }

  // No `written !== calibration.payloadLength` check here: each iteration
  // contributes exactly `Math.min(FRAME_BYTES, remaining)` bytes and
  // decodePayloadFrame always returns a buffer of exactly the requested
  // length or throws, so written provably always equals payloadLength by
  // the time the loop above finishes -- a mismatch here would be untestable
  // dead code, not a real defense against a malformed file.
  const digest = hash.digest();
  if (!digest.equals(calibration.payloadDigest)) {
    throw new Error("gptungif-v4: SHA-256 digest mismatch; no recovered output has been published");
  }
  return Buffer.concat(chunks);
}
