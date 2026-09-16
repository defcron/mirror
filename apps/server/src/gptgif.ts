// gptgif (original/master format): visually encodes bytes as hex digits
// rendered as 8x8 glyphs in a 640x480 indexed-color GIF animation, one frame
// per 4800-character chunk. This is a native TS port of the real gptgif.c
// encoder and gptungif.py decoder (both read in full from the user's
// reference repo) -- both the encode AND decode paths are ported, including
// the decode side's quirks (see decodeGptgif's doc comment).
//
// Reference sources ported here:
//   gptgif.c     -- C encoder using giflib
//   gptungif.py  -- Python decoder using PIL/numpy/sklearn + a bash pipeline
import { gunzipSync, gzipSync } from "node:zlib";
import { type GifColor, type GifImage, readGif, writeGif } from "./gif89a.js";

const WIDTH = 640;
const HEIGHT = 480;
const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 8;
const COLS = WIDTH / GLYPH_WIDTH; // 80
const ROWS = HEIGHT / GLYPH_HEIGHT; // 60
const FRAME_CHARS = COLS * ROWS; // 4800
const COLOR_COUNT = 256;
const HEX_CHARS = "0123456789abcdef";

// Verbatim from gptgif.c's `font[16][8]` -- a compressed DOS-style hex font
// with a 1px spacing margin inside each 8x8 cell. Also gptgif-v4.c's default
// built-in font is byte-for-byte identical to this one, so v4 reuses it.
export const FONT: readonly (readonly number[])[] = [
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

/** Verbatim from gptgif.c's palette-building loop in main(). */
function buildPalette(): GifColor[] {
  const colors: GifColor[] = [{ r: 0, g: 0, b: 0 }];
  for (let i = 1; i < COLOR_COUNT; i++) {
    colors.push({
      r: i < 128 ? i * 2 : 255,
      g: i < 128 ? 255 - i * 2 : (i - 128) * 2,
      b: 255 - i,
    });
  }
  return colors;
}

/** Verbatim from gptgif.c's draw_char(): sets pixels for one glyph cell. */
function drawChar(raster: Uint8Array, x: number, y: number, ch: string, frame: number): void {
  // encodeGptgif is this function's only caller, and it only ever passes
  // characters straight from `Buffer.toString("hex")` -- always one of
  // HEX_CHARS -- so there is no real input for which indexOf returns -1
  // here; a defensive fallback for that case would be untestable dead code.
  const glyph = FONT[HEX_CHARS.indexOf(ch)];
  for (let dy = 0; dy < GLYPH_HEIGHT; dy++) {
    for (let dx = 0; dx < GLYPH_WIDTH; dx++) {
      if (glyph[dy] & (1 << (7 - dx))) {
        const brightness = 32 + ((frame + dy + dx) % 223); // avoid background index 0
        raster[(y + dy) * WIDTH + (x + dx)] = brightness;
      }
    }
  }
}

/**
 * Encodes one or more input buffers as a gptgif GIF: their bytes are
 * concatenated, hex-encoded, and rendered as glyphs across as many
 * 640x480 frames as needed (4800 hex characters per frame).
 */
export function encodeGptgif(inputs: Buffer[]): Buffer {
  const hex = Buffer.concat(inputs).toString("hex");
  const palette = buildPalette();
  const frames: { pixels: Uint8Array; delayCs?: number }[] = [];

  for (let offset = 0, frame = 0; offset < hex.length; offset += FRAME_CHARS, frame++) {
    const chunk = hex.slice(offset, offset + FRAME_CHARS);
    const raster = new Uint8Array(WIDTH * HEIGHT); // zero-initialized: background index 0
    for (let i = 0; i < chunk.length; i++) {
      const row = Math.floor(i / COLS);
      const col = i % COLS;
      drawChar(raster, col * GLYPH_WIDTH, row * GLYPH_HEIGHT, chunk[i], frame);
    }
    frames.push({ pixels: raster, delayCs: 30 }); // gptgif.c's GCE: {0x00, 30, 0x00, 0x00}
  }
  // Matches gptgif.c's for-loop exactly: `offset=0 < hex_len=0` is false for
  // empty input, so it (and this) emits zero frames rather than one blank one.
  return writeGif({ width: WIDTH, height: HEIGHT, globalColorTable: palette, frames });
}

/** PIL's `Image.convert("L")` luma formula, in the same fixed-point form Pillow's C code uses. */
function luma(color: GifColor): number {
  return (color.r * 19595 + color.g * 38470 + color.b * 7471 + 0x8000) >> 16;
}

/** A 64-bit glyph-cell bitmask (bit `dy*8+dx` set when that pixel binarized to 1). */
type GlyphMask = bigint;

function tileMask(binary: Uint8Array, width: number, x0: number, y0: number): { mask: GlyphMask; sum: number } {
  let mask = 0n;
  let sum = 0;
  for (let dy = 0; dy < GLYPH_HEIGHT; dy++) {
    for (let dx = 0; dx < GLYPH_WIDTH; dx++) {
      if (binary[(y0 + dy) * width + (x0 + dx)]) {
        mask |= 1n << BigInt(dy * GLYPH_WIDTH + dx);
        sum++;
      }
    }
  }
  return { mask, sum };
}

/**
 * Extracts glyph-cell bitmasks across all frames, in gptungif.py's exact
 * frame -> row -> col order, halting the moment a near-empty tile is seen
 * (mirroring `np.sum(glyph) < 5`) -- exactly gptungif.py's `extraction_halted`
 * behavior, since gptgif.c always pads the final frame's unused cells with
 * background (all-zero) pixels.
 */
function extractGlyphTiles(gif: GifImage): GlyphMask[] {
  const tiles: GlyphMask[] = [];
  outer: for (const frame of gif.frames) {
    const binary = new Uint8Array(gif.width * gif.height);
    for (let i = 0; i < frame.pixels.length; i++) {
      const color = gif.globalColorTable[frame.pixels[i]] ?? { r: 0, g: 0, b: 0 };
      binary[i] = luma(color) > 128 ? 1 : 0;
    }
    const rows = Math.floor(gif.height / GLYPH_HEIGHT);
    const cols = Math.floor(gif.width / GLYPH_WIDTH);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const { mask, sum } = tileMask(binary, gif.width, col * GLYPH_WIDTH, row * GLYPH_HEIGHT);
        if (sum < 5) break outer;
        tiles.push(mask);
      }
    }
  }
  return tiles;
}

function hammingDistance(a: GlyphMask, b: GlyphMask): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export interface ClusterResult {
  labels: number[];
  /** Per-pixel average brightness (0-1) of the tiles in each cluster, row-major 8x8. */
  centroids: number[][];
}

/**
 * Groups glyph tiles into `k` clusters by shape.
 *
 * The real gptungif.py runs sklearn's `KMeans(n_clusters=k, random_state=0,
 * n_init=10)` on the flattened tiles. Reproducing that bit-for-bit would mean
 * porting NumPy's legacy Mersenne-Twister RandomState and sklearn's k-means++
 * seeding -- and it wouldn't buy anything, because gptgif's own encoder never
 * anti-aliases: every rendered glyph cell is one of exactly 16 crisp on/off
 * bit patterns (the font table), so any correct clustering algorithm
 * partitions well-formed input identically; the two only differ in which
 * arbitrary index each partition is labeled. That arbitrariness is exactly
 * why the CLI has a `--cluster-map` option and prints a warning about it --
 * label order was never meant to be predictable, only self-consistent within
 * one run. So this groups tiles by exact mask equality, in first-seen order,
 * merging any additional distinct mask into its nearest existing cluster by
 * Hamming distance once `k` clusters already exist (covering noisy/real-world
 * input, not just this module's own crisp output).
 */
export function clusterGlyphTiles(tiles: GlyphMask[], k: number): ClusterResult {
  const clusterMasks: GlyphMask[] = [];
  const labels: number[] = new Array(tiles.length);
  for (let i = 0; i < tiles.length; i++) {
    const mask = tiles[i];
    let label = clusterMasks.indexOf(mask);
    if (label < 0) {
      if (clusterMasks.length < k) {
        label = clusterMasks.length;
        clusterMasks.push(mask);
      } else {
        label = 0;
        let best = hammingDistance(mask, clusterMasks[0]);
        for (let c = 1; c < clusterMasks.length; c++) {
          const d = hammingDistance(mask, clusterMasks[c]);
          if (d < best) {
            best = d;
            label = c;
          }
        }
      }
    }
    labels[i] = label;
  }
  const centroids: number[][] = Array.from({ length: k }, () => new Array(GLYPH_WIDTH * GLYPH_HEIGHT).fill(0));
  const counts = new Array(k).fill(0);
  for (let i = 0; i < tiles.length; i++) {
    const label = labels[i];
    counts[label]++;
    for (let bit = 0; bit < GLYPH_WIDTH * GLYPH_HEIGHT; bit++) {
      if (tiles[i] & (1n << BigInt(bit))) centroids[label][bit]++;
    }
  }
  for (let c = 0; c < k; c++) {
    if (counts[c] === 0) continue;
    for (let bit = 0; bit < GLYPH_WIDTH * GLYPH_HEIGHT; bit++) centroids[c][bit] /= counts[c];
  }
  return { labels, centroids };
}

const DEFAULT_CLUSTER_MAP = "0123456789abcdef";

/**
 * Renders the same ASCII-art calibration report gptungif.py's `--calibrate`
 * mode prints to stderr: each cluster's centroid, visualized as an 8x8 grid
 * of `#`/`.` (threshold > 0.5), so the caller can work out the correct
 * cluster-map ordering for their input (the ordering is not, and never was,
 * predictable -- see clusterGlyphTiles's doc comment).
 */
export function calibrateGptgif(gif: Buffer, options: { clusterMap?: string } = {}): string {
  const clusterMap = options.clusterMap ?? DEFAULT_CLUSTER_MAP;
  const image = readGif(gif);
  const tiles = extractGlyphTiles(image);
  const { centroids } = clusterGlyphTiles(tiles, clusterMap.length);
  const lines: string[] = ["K-Means Cluster Centroids (visualized as 8x8 glyphs):"];
  for (let i = 0; i < centroids.length; i++) {
    lines.push("", `Cluster Label: ${i}`);
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      let line = "";
      for (let col = 0; col < GLYPH_WIDTH; col++) {
        line += centroids[i][row * GLYPH_WIDTH + col] > 0.5 ? "#" : ".";
      }
      lines.push(line);
    }
    lines.push("-".repeat(20));
  }
  lines.push("", "Now associate each index with the correct character from the cluster map.");
  return lines.join("\n");
}

/**
 * Decodes a gptgif GIF back to bytes.
 *
 * Faithfully preserves gptungif.py's own quirk: the reference decoder never
 * hands back the raw decoded bytes directly. It writes the reconstructed hex
 * string to a temp file and literally shells out to
 * `bash -i -l -c "xxd -p -r < hexfile | gzip -9"`, so its actual stdout is
 * the **gzip-compressed** raw bytes, not the raw bytes themselves. This
 * returns that same gzip-wrapped buffer -- callers that want the original
 * bytes must gunzip the result themselves, exactly as a real caller piping
 * gptungif.py's stdout would.
 */
export function decodeGptgif(gif: Buffer, options: { clusterMap?: string } = {}): Buffer {
  const clusterMap = options.clusterMap ?? DEFAULT_CLUSTER_MAP;
  const image = readGif(gif);
  const tiles = extractGlyphTiles(image);
  const { labels } = clusterGlyphTiles(tiles, clusterMap.length);
  const hex = labels.map((label) => clusterMap[label]).join("");
  // `xxd -p -r` decodes hex pairs; an odd trailing nibble (malformed input)
  // is what xxd itself would silently drop the last char for, so truncate
  // to an even length the same way rather than throwing.
  const evenHex = hex.length % 2 === 0 ? hex : hex.slice(0, -1);
  const raw = Buffer.from(evenHex, "hex");
  return gzipSync(raw, { level: 9 });
}

/**
 * Undoes decodeGptgif's gzip-wrap quirk, recovering the original bytes --
 * exactly what a caller piping gptungif.py's real stdout through `gunzip`
 * would get back.
 */
export function gunzipGptgifOutput(compressed: Buffer): Buffer {
  return gunzipSync(compressed);
}
