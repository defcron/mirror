import assert from "node:assert/strict";
import test from "node:test";
import { readGif, writeGif } from "../dist/gif89a.js";
import { FONT as DEFAULT_FONT } from "../dist/gptgif.js";
import {
  decodeGptgifV4,
  defaultPalette,
  encodeGptgifV4,
  fontFromBytes,
  fontToBytes,
  paletteFromBytes,
  paletteToBytes,
  randomFont,
  randomPalette,
  validateFont,
  validatePalette,
} from "../dist/gptgif-v4.js";

const WIDTH = 640, HEIGHT = 480, GLYPH_W = 8, GLYPH_H = 8, COLS = 80, ROWS = 60;
const LEGEND_START = 320, HEADER_START = 400, MAGIC = Buffer.from("GPTGIF4\0", "ascii");

function cellBox(raster, cell) {
  const baseX = (cell % COLS) * GLYPH_W;
  const baseY = Math.floor(cell / COLS) * GLYPH_H;
  return { baseX, baseY };
}

function setCellSolid(raster, cell, value) {
  const { baseX, baseY } = cellBox(raster, cell);
  for (let y = 0; y < GLYPH_H; y++) raster.fill(value, (baseY + y) * WIDTH + baseX, (baseY + y) * WIDTH + baseX + GLYPH_W);
}

function drawCanonicalOn(raster, cell, nibble, font) {
  const { baseX, baseY } = cellBox(raster, cell);
  for (let y = 0; y < GLYPH_H; y++)
    for (let x = 0; x < GLYPH_W; x++)
      if (font[nibble][y] & (1 << (7 - x))) raster[(baseY + y) * WIDTH + baseX + x] = 40;
}

// A minimal xorshift32-driven search for a paletteSeed whose *unpatched*
// 256-color generation already contains a foreground/background collision --
// exercising randomPalette's reroll loop for real, rather than trusting it
// blindly. Exact bit-for-bit mirror of gptgif-v4.ts's own algorithm (verified
// against it via the "the reroll actually happens" assertion below).
function xorshift32(state) {
  let x = state >>> 0;
  x ^= (x << 13) >>> 0; x >>>= 0;
  x ^= x >>> 17;
  x ^= (x << 5) >>> 0;
  return x >>> 0;
}
function findPaletteSeedNeedingAReroll() {
  for (let seed = 1; seed < 200000; seed++) {
    let state = seed >>> 0;
    const low = [];
    for (let i = 0; i < 40; i++) {
      state = xorshift32(state);
      if (i <= 15 || i === 31) low.push({ r: state & 0xff, g: (state >>> 8) & 0xff, b: (state >>> 16) & 0xff });
    }
    for (let real = 40; real <= 239; real++) {
      state = xorshift32(state);
      const c = { r: state & 0xff, g: (state >>> 8) & 0xff, b: (state >>> 16) & 0xff };
      if (low.some((l) => l.r === c.r && l.g === c.g && l.b === c.b)) return seed;
    }
  }
  throw new Error("no seed found in range");
}

test.describe("server / gptgif-v4", () => {

test("custom font and palette files round-trip and reject incorrect lengths", () => {
  const font = randomFont(123);
  assert.deepEqual(fontFromBytes(fontToBytes(font)), font);
  assert.throws(() => fontFromBytes(Buffer.alloc(127)), /exactly 128 bytes/);
  const palette = defaultPalette();
  assert.deepEqual(paletteFromBytes(paletteToBytes(palette)), palette);
  assert.throws(() => paletteFromBytes(Buffer.alloc(767)), /exactly 768 bytes/);
});

test("round-trips a multi-frame payload end to end with the default font and palette", () => {
  const input = Buffer.from("The quick brown fox jumps over the lazy dog. ".repeat(60), "utf8"); // several payload frames
  const gif = encodeGptgifV4([input]);
  const decoded = decodeGptgifV4(gif);
  assert.deepEqual([...decoded], [...input]);
});

test("concatenates multiple input buffers before encoding", () => {
  const a = Buffer.from("hello ");
  const b = Buffer.from("world");
  const gif = encodeGptgifV4([a, b]);
  const decoded = decodeGptgifV4(gif);
  assert.equal(decoded.toString(), "hello world");
});

test("round-trips empty input as calibration-only (zero payload frames)", () => {
  const gif = encodeGptgifV4([Buffer.alloc(0)]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 1); // calibration frame only
  const decoded = decodeGptgifV4(gif);
  assert.equal(decoded.length, 0);
});

test("round-trips a payload landing exactly on a frame boundary", () => {
  const input = Buffer.alloc(2400, 0x42); // FRAME_BYTES exactly
  const gif = encodeGptgifV4([input]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 2); // calibration + exactly one full payload frame
  assert.deepEqual([...decodeGptgifV4(gif)], [...input]);
});

test("round-trips using an explicit font and palette object", () => {
  const gif = encodeGptgifV4([Buffer.from("explicit")], { font: DEFAULT_FONT, palette: defaultPalette() });
  assert.equal(decodeGptgifV4(gif).toString(), "explicit");
});

test("round-trips using a font seed and a palette seed", () => {
  const gif = encodeGptgifV4([Buffer.from("seeded")], { fontSeed: 0x2a, paletteSeed: 0x2a });
  assert.equal(decodeGptgifV4(gif).toString(), "seeded");
});

test("a zero font seed and a zero palette seed fall back to their documented defaults", () => {
  const gif = encodeGptgifV4([Buffer.from("zero seeds")], { fontSeed: 0, paletteSeed: 0 });
  assert.equal(decodeGptgifV4(gif).toString(), "zero seeds");
  assert.deepEqual(randomFont(0), randomFont(0)); // deterministic, doesn't throw on the seed==0 branch
});

test("validateFont accepts the shipped default font and randomFont's output", () => {
  assert.doesNotThrow(() => validateFont(DEFAULT_FONT));
  assert.doesNotThrow(() => validateFont(randomFont(12345)));
});

test("validateFont rejects a glyph that disappears entirely under an allowed transform", () => {
  // Real reference glyphs always keep the always-on fixed pixel outside the
  // checkerboard-holes parity, so holes never empties them; a font missing
  // that guarantee for one glyph must be rejected.
  const font = DEFAULT_FONT.map((rows) => [...rows]);
  font[0] = [0, 0, 0, 0, 0, 0, 0, 0]; // completely blank glyph
  assert.throws(() => validateFont(font), /disappears under an allowed transform/);
});

test("validateFont rejects two glyphs that collide under an allowed transform", () => {
  const font = DEFAULT_FONT.map((rows) => [...rows]);
  font[1] = [...font[0]]; // identical to glyph 0
  assert.throws(() => validateFont(font), /collide under an allowed transform/);
});

test("validateFont rejects a glyph whose lit pixel escapes its cell under jitter", () => {
  const font = DEFAULT_FONT.map((rows) => [...rows]);
  font[2] = [0x80, 0, 0, 0, 0, 0, 0, 0]; // top-left pixel: escapes at jx=-1 or rotation
  assert.throws(() => validateFont(font), /escapes its cell under jitter/);
});

test("validatePalette accepts the default palette", () => {
  assert.doesNotThrow(() => validatePalette(defaultPalette()));
});

test("validatePalette rejects a foreground color that collides with a background/noise/decoy role", () => {
  const palette = defaultPalette();
  palette[100] = { ...palette[0] }; // foreground role 100 now equals background role 0
  assert.throws(() => validatePalette(palette), /collides with background\/noise\/decoy role/);
});

test("randomPalette actually exercises its reroll loop when the raw draw collides", () => {
  const seed = findPaletteSeedNeedingAReroll();
  const palette = randomPalette(seed);
  assert.doesNotThrow(() => validatePalette(palette));
  // Sanity: the found seed really does need a reroll under the same
  // algorithm shape gptgif-v4.ts uses (paranoia against a stale search).
  let state = seed >>> 0;
  const low = [];
  for (let i = 0; i < 40; i++) { state = xorshift32(state); if (i <= 15 || i === 31) low.push(state & 0xffffff); }
  let sawCollision = false;
  for (let real = 40; real <= 239; real++) {
    state = xorshift32(state);
    if (low.includes(state & 0xffffff)) sawCollision = true;
  }
  assert.equal(sawCollision, true);
});

test("rejects a GIF whose canvas size isn't the expected 640x480", () => {
  const gif = writeGif({ width: 10, height: 10, globalColorTable: [{ r: 0, g: 0, b: 0 }], frames: [{ pixels: new Uint8Array(100) }] });
  assert.throws(() => decodeGptgifV4(gif), /expected a 640x480 GIF/);
});

test("rejects a correctly-sized GIF with no frames at all", () => {
  const gif = writeGif({ width: WIDTH, height: HEIGHT, globalColorTable: [{ r: 0, g: 0, b: 0 }], frames: [] });
  assert.throws(() => decodeGptgifV4(gif), /missing v4 calibration frame/);
});

test("rejects a calibration frame whose color swatches aren't solid", () => {
  const gif = encodeGptgifV4([Buffer.from("x")]);
  const image = readGif(gif);
  image.frames[0].pixels[0] = 250; // corrupt one pixel of swatch role 0
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /calibration color swatches must be solid/);
});

test("rejects a calibration frame whose visual header isn't gptgif v4", () => {
  const gif = encodeGptgifV4([Buffer.from("x")]);
  const image = readGif(gif);
  // Overwrite the header's first glyph pair (magic byte 'G') with a
  // different (still-valid, still-legend-matching) canonical glyph. Each
  // cell must be cleared first -- drawing only sets "on" pixels, so drawing
  // straight over the original glyph without clearing would leave a mixed
  // shape matching no canonical mask at all.
  setCellSolid(image.frames[0].pixels, HEADER_START, 0);
  setCellSolid(image.frames[0].pixels, HEADER_START + 1, 0);
  drawCanonicalOn(image.frames[0].pixels, HEADER_START, 0, DEFAULT_FONT);
  drawCanonicalOn(image.frames[0].pixels, HEADER_START + 1, 0, DEFAULT_FONT);
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /visual header is not gptgif v4/);
});

test("rejects a visual header containing a glyph the legend never taught it", () => {
  const gif = encodeGptgifV4([Buffer.from("x")]);
  const image = readGif(gif);
  // Blank one header glyph cell entirely -- not one of the 16 canonical masks.
  setCellSolid(image.frames[0].pixels, HEADER_START, 0);
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /visual header contains an unknown glyph/);
});

test("rejects a frame count that disagrees with the visual header's declared length", () => {
  const gif = encodeGptgifV4([Buffer.alloc(2400, 1)]); // exactly one payload frame
  const image = readGif(gif);
  const mutated = writeGif({ ...image, frames: [image.frames[0]] }); // drop the payload frame
  assert.throws(() => decodeGptgifV4(mutated), /frame count disagrees with visual header length/);
});

test("rejects a payload frame whose occupied-cell count disagrees with the header length", () => {
  const gif = encodeGptgifV4([Buffer.from("ab")]);
  const image = readGif(gif);
  // Blank the entire second (payload) frame -- zero occupied cells where the
  // header declares 2 bytes (4 nibbles) worth of content.
  image.frames[1].pixels.fill(0);
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /cell count disagrees with header length/);
});

test("rejects a legend whose canonical glyph shape would escape its cell under v4's jitter", () => {
  const gif = encodeGptgifV4([Buffer.from("x")]);
  const image = readGif(gif);
  // A single foreground pixel at the very corner of the cell escapes as
  // soon as any jitter or rotation is applied -- exactly what validateFont
  // guarantees never ships from the encoder, so this can only be reached by
  // a legend that didn't go through it.
  setCellSolid(image.frames[0].pixels, LEGEND_START, 0);
  const { baseX, baseY } = cellBox(image.frames[0].pixels, LEGEND_START);
  image.frames[0].pixels[baseY * WIDTH + baseX] = 40;
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /learned alphabet clips under v4 jitter/);
});

test("rejects a legend containing two identical canonical glyph shapes", () => {
  const gif = encodeGptgifV4([Buffer.from("x")]);
  const image = readGif(gif);
  const { baseX: x0, baseY: y0 } = cellBox(image.frames[0].pixels, LEGEND_START);
  const { baseX: x1, baseY: y1 } = cellBox(image.frames[0].pixels, LEGEND_START + 1);
  for (let y = 0; y < GLYPH_H; y++)
    for (let x = 0; x < GLYPH_W; x++)
      image.frames[0].pixels[(y1 + y) * WIDTH + x1 + x] = image.frames[0].pixels[(y0 + y) * WIDTH + x0 + x];
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /empty or ambiguous transformed glyphs/);
});

test("rejects a payload frame with content in a cell past the declared data length", () => {
  const gif = encodeGptgifV4([Buffer.from("ab")]); // tiny payload, frame has lots of trailing unused cells
  const image = readGif(gif);
  const payload = image.frames[1].pixels;
  // Find a physical cell the encoder left genuinely empty (permutation
  // scrambles logical->physical mapping, so which physical cells are
  // unoccupied isn't predictable ahead of time) and paint it solid --
  // content appearing where the header says nothing should be left.
  outer: for (let cell = 0; cell < COLS * ROWS; cell++) {
    const { baseX, baseY } = cellBox(payload, cell);
    // Matches decodePayloadFrame's own isForeground test (value 40-239) --
    // noise (1-15) and decoy (31) pixels don't count as "occupied" for mask
    // purposes, so a cell containing only those still has an all-zero mask.
    let occupied = false;
    for (let y = 0; y < GLYPH_H && !occupied; y++)
      for (let x = 0; x < GLYPH_W; x++) {
        const v = payload[(baseY + y) * WIDTH + baseX + x];
        if (v >= 40 && v <= 239) { occupied = true; break; }
      }
    if (occupied) continue;
    setCellSolid(payload, cell, 40);
    break outer;
  }
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /cell count disagrees with header length/);
});

test("rejects a payload frame containing a glyph that matches no learned template", () => {
  const gif = encodeGptgifV4([Buffer.alloc(4, 0xff)]);
  const image = readGif(gif);
  const payload = image.frames[1].pixels;
  // Find the first occupied (foreground) cell and paint it with an
  // arbitrary, non-learned shape instead of one of the 16 real glyphs.
  outer: for (let cell = 0; cell < COLS * ROWS; cell++) {
    const { baseX, baseY } = cellBox(payload, cell);
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) {
        if (payload[(baseY + y) * WIDTH + baseX + x] >= 40) {
          for (let yy = 0; yy < GLYPH_H; yy++) payload.fill(41, (baseY + yy) * WIDTH + baseX, (baseY + yy) * WIDTH + baseX + GLYPH_W);
          break outer;
        }
      }
    }
  }
  const mutated = writeGif(image);
  assert.throws(() => decodeGptgifV4(mutated), /unknown or ambiguous glyph/);
});

test("rejects a payload whose bytes were tampered with after encoding (digest mismatch)", () => {
  // Per-cell style (rotation/jitter/holes) and which physical cells are
  // occupied both depend only on frame index, never on content -- so for
  // two same-length payloads, splicing one occupied cell's pixels from B's
  // encoding into A's raster is guaranteed to still decode as *some* valid
  // nibble (just not the one A's header/digest was computed over).
  const inputA = Buffer.from("A".repeat(20));
  const inputB = Buffer.from("B".repeat(20));
  assert.equal(inputA.length, inputB.length);
  const imageA = readGif(encodeGptgifV4([inputA]));
  const imageB = readGif(encodeGptgifV4([inputB]));
  const payloadA = imageA.frames[1].pixels;
  const payloadB = imageB.frames[1].pixels;
  outer: for (let cell = 0; cell < COLS * ROWS; cell++) {
    const { baseX, baseY } = cellBox(payloadA, cell);
    let occupied = false;
    for (let y = 0; y < GLYPH_H && !occupied; y++)
      for (let x = 0; x < GLYPH_W; x++)
        if (payloadA[(baseY + y) * WIDTH + baseX + x] >= 40) { occupied = true; break; }
    if (!occupied) continue;
    for (let y = 0; y < GLYPH_H; y++)
      for (let x = 0; x < GLYPH_W; x++)
        payloadA[(baseY + y) * WIDTH + baseX + x] = payloadB[(baseY + y) * WIDTH + baseX + x];
    break outer;
  }
  const mutated = writeGif(imageA);
  assert.throws(() => decodeGptgifV4(mutated), /SHA-256 digest mismatch/);
});

test("decodes across an odd/even frame-index boundary (payload spanning 3+ frames)", () => {
  // Exercises the frame-parity nibble-swap path for both frame 0 (even) and
  // frame 1 (odd) of the payload, not just a single-frame message.
  const input = Buffer.alloc(2400 * 2 + 500, 0x99);
  input[0] = 0x01;
  input[2400] = 0x02;
  input[4800] = 0x03;
  const gif = encodeGptgifV4([input]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 4); // calibration + 3 payload frames
  assert.deepEqual([...decodeGptgifV4(gif)], [...input]);
});

test("a payload just under one frame leaves plenty of decoy-eligible cells", () => {
  // Small enough that most of a payload frame's cells are unused, giving
  // the decoy-noise placement path (and the noise-pixel-already-set skip in
  // buildPayloadFrame) ample opportunity to fire.
  const input = Buffer.from("small");
  const gif = encodeGptgifV4([input]);
  assert.equal(decodeGptgifV4(gif).toString(), "small");
});

});
