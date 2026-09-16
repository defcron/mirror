import assert from "node:assert/strict";
import test from "node:test";
import { readGif, writeGif } from "../dist/gif89a.js";
import {
  calibrateGptgif,
  clusterGlyphTiles,
  decodeGptgif,
  encodeGptgif,
  gunzipGptgifOutput,
} from "../dist/gptgif.js";

// clusterGlyphTiles labels clusters in first-seen order (see the module's
// own doc comment on why this is inherent to the format, not a bug), so
// decoding needs the caller to supply the mapping derived the same way --
// exactly what a real user would do after eyeballing --calibrate output.
function firstSeenClusterMap(originalHex, alphabetSize) {
  const seen = [];
  for (const ch of originalHex) {
    if (!seen.includes(ch)) seen.push(ch);
    if (seen.length === alphabetSize) break;
  }
  return seen.join("");
}

test.describe("server / gptgif", () => {

test("round-trips a short, all-16-hex-digit message using the derived ground-truth cluster map", () => {
  // Deliberately touches every one of the 16 hex digits at least once, so
  // no cluster in the default k=16 clustering ends up empty.
  const input = Buffer.from("0123456789abcdef 0123456789abcdef", "utf8");
  const gif = encodeGptgif([input]);
  const hex = input.toString("hex");
  const clusterMap = firstSeenClusterMap(hex, 16);
  const decoded = gunzipGptgifOutput(decodeGptgif(gif, { clusterMap }));
  assert.deepEqual([...decoded], [...input]);
});

test("concatenates multiple input buffers before encoding", () => {
  const a = Buffer.from("hello ");
  const b = Buffer.from("world");
  const gif = encodeGptgif([a, b]);
  const hex = Buffer.concat([a, b]).toString("hex");
  const clusterMap = firstSeenClusterMap(hex, 16);
  const decoded = gunzipGptgifOutput(decodeGptgif(gif, { clusterMap }));
  assert.equal(decoded.toString(), "hello world");
});

test("encodes empty input as zero frames, and decodes back to zero bytes", () => {
  const gif = encodeGptgif([Buffer.alloc(0)]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 0);
  const decoded = gunzipGptgifOutput(decodeGptgif(gif));
  assert.equal(decoded.length, 0);
});

test("encodes an input landing exactly on a frame boundary without an extra blank frame", () => {
  // 4800 hex chars/frame = 2400 bytes exactly.
  const input = Buffer.alloc(2400, 0xab);
  const gif = encodeGptgif([input]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 1);
  // Every cell in this frame carries real content -- no background padding
  // cell ever appears -- so glyph-tile extraction must walk every row and
  // column to completion instead of ever halting early.
  const clusterMap = firstSeenClusterMap(input.toString("hex"), 16);
  const decoded = gunzipGptgifOutput(decodeGptgif(gif, { clusterMap }));
  assert.deepEqual([...decoded], [...input]);
});

test("spills into a second frame for input one byte past a frame boundary", () => {
  const input = Buffer.alloc(2401, 0xab); // 4802 hex chars -> needs a second frame
  const gif = encodeGptgif([input]);
  const image = readGif(gif);
  assert.equal(image.frames.length, 2);
});

test("a decode using fewer distinct digits than the cluster count leaves some clusters empty", () => {
  // Only digits 'a' and 'b' ever appear, so 14 of the default 16 clusters
  // never get a member -- exercises the empty-cluster skip when averaging
  // centroids, alongside the populated-cluster branch the other tests hit.
  const input = Buffer.from([0xab, 0xab, 0xab, 0xab]); // hex: "abababab"
  const gif = encodeGptgif([input]);
  const clusterMap = firstSeenClusterMap(input.toString("hex"), 16);
  const decoded = gunzipGptgifOutput(decodeGptgif(gif, { clusterMap }));
  assert.deepEqual([...decoded], [...input]);
  // calibrateGptgif must still render all 16 (mostly-empty) cluster reports
  // without dividing by a zero count.
  const report = calibrateGptgif(gif);
  assert.match(report, /Cluster Label: 15/);
});

test("clusterGlyphTiles merges extra distinct shapes into the nearest existing cluster once k is full", () => {
  const input = Buffer.from("0123456789abcdef", "utf8"); // many distinct hex digits
  const gif = encodeGptgif([input]);
  const image = readGif(gif);
  // Force k=2: with clearly more than 2 distinct glyph shapes in the data,
  // every shape past the first 2 must merge into whichever of those 2 it's
  // closer to by Hamming distance.
  const report = calibrateGptgif(gif, { clusterMap: "01" });
  assert.match(report, /Cluster Label: 0/);
  assert.match(report, /Cluster Label: 1/);
  assert.doesNotMatch(report, /Cluster Label: 2/);
});

test("clusterGlyphTiles recognizes a tile matching an already-established cluster", () => {
  // A repeated digit ('0' recurring many times) means most tiles match an
  // existing cluster by exact mask rather than starting a new one --
  // exercises the `label >= 0` fast path directly, not just via encode/decode.
  const tiles = [1n, 2n, 1n, 3n, 1n, 2n];
  const { labels } = clusterGlyphTiles(tiles, 3);
  assert.equal(labels[0], labels[2]);
  assert.equal(labels[0], labels[4]);
  assert.equal(labels[1], labels[5]);
  assert.equal(new Set(labels).size, 3);
});

test("calibrateGptgif's report lists every cluster centroid as an 8x8 grid of # and .", () => {
  const gif = encodeGptgif([Buffer.from("calibrate me")]);
  const report = calibrateGptgif(gif);
  assert.match(report, /K-Means Cluster Centroids/);
  assert.match(report, /^[#.]{8}$/m);
  assert.match(report, /associate each index with the correct character/);
});

// Bit-exact re-implementation of BitWriter's packing (see gif89a.test.mjs
// for the full rationale) -- used here only to build a raw GIF whose pixel
// values legitimately exceed its own declared color table, which writeGif's
// public API can't produce on its own (it always ties the table size to the
// same minCodeSize used to encode the pixels, so shrinking the table also
// changes how large a pixel value can safely round-trip).
function packCodes(codes) {
  const bytes = [];
  let bitBuffer = 0, bitCount = 0;
  for (const [code, width] of codes) {
    bitBuffer |= code << bitCount;
    bitCount += width;
    while (bitCount >= 8) { bytes.push(bitBuffer & 0xff); bitBuffer >>= 8; bitCount -= 8; }
  }
  if (bitCount > 0) bytes.push(bitBuffer & 0xff);
  return Buffer.from(bytes);
}

function subBlocks(data) {
  const chunks = [];
  let offset = 0;
  while (offset < data.length) {
    const size = Math.min(255, data.length - offset);
    chunks.push(Buffer.from([size]), data.subarray(offset, offset + size));
    offset += size;
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

test("a pixel indexing past its (deliberately small) color table falls back to black instead of throwing", () => {
  // minCodeSize=8 correctly encodes pixel value 200 as a safe literal code
  // (well below clearCode=256) while the declared global color table only
  // has 4 entries -- a shape writeGif's own API can't produce, since it
  // always sizes the table to match the minCodeSize it picks.
  const chunks = [Buffer.from("GIF89a", "ascii")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(2, 0);
  lsd.writeUInt16LE(1, 2);
  lsd[4] = 0x80 | 1; // global color table present, colorBits=2 -> 4 entries
  chunks.push(lsd);
  chunks.push(Buffer.alloc(4 * 3, 5));
  const imageDescriptor = Buffer.alloc(10);
  imageDescriptor[0] = 0x2c;
  imageDescriptor.writeUInt16LE(2, 5);
  imageDescriptor.writeUInt16LE(1, 7);
  chunks.push(imageDescriptor);
  chunks.push(Buffer.from([8])); // minCodeSize
  chunks.push(subBlocks(packCodes([[256, 9], [0, 9], [200, 9], [257, 9]])));
  chunks.push(Buffer.from([0x3b]));
  const gif = Buffer.concat(chunks);
  assert.doesNotThrow(() => calibrateGptgif(gif));
});

test("decoding a truncated (odd tile count) stream drops the trailing nibble like xxd would", () => {
  // encodeGptgif always draws hex digits in pairs (one byte = two nibbles),
  // so an odd number of *real* (non-background) tiles can only happen if
  // the rendered pixels are altered after encoding -- exactly what a
  // genuinely corrupted or partially-overwritten file would look like.
  const input = Buffer.from([0x12]); // hex "12" -> two real glyph tiles, frame 0
  const gif = encodeGptgif([input]);
  const image = readGif(gif);
  const raster = image.frames[0].pixels;
  // Blank the second glyph cell (row 0, col 1) back to background (index 0),
  // leaving exactly one real tile before the extraction halt.
  const WIDTH = 640, GLYPH_W = 8, GLYPH_H = 8;
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      raster[y * WIDTH + (GLYPH_W + x)] = 0;
    }
  }
  const mutated = writeGif(image);
  const clusterMap = firstSeenClusterMap("1", 16); // only one real digit left: '1'
  const decoded = gunzipGptgifOutput(decodeGptgif(mutated, { clusterMap }));
  // The lone odd trailing nibble is dropped, exactly as `xxd -p -r` would.
  assert.equal(decoded.length, 0);
});

});
