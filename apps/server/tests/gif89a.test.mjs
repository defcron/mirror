import assert from "node:assert/strict";
import test from "node:test";
import { readGif, writeGif } from "../dist/gif89a.js";

// Bit-exact re-implementation of BitWriter's packing algorithm (LSB-first,
// variable-width codes), used only to hand-craft malformed/edge-case LZW
// streams that writeGif itself would never produce (it only ever emits
// literal codes -- see gif89a.ts's own comment on why). Letting this helper
// do the bit math instead of hand-computing hex bytes keeps the crafted
// fixtures below verifiably correct rather than trusting arithmetic by eye.
function packCodes(codes) {
  const bytes = [];
  let bitBuffer = 0;
  let bitCount = 0;
  for (const [code, width] of codes) {
    bitBuffer |= code << bitCount;
    bitCount += width;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
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

// Builds a minimal, hand-assembled GIF89a: header + LSD + a tiny global
// color table + one image (optionally with its own local color table),
// skipping the Graphics Control Extension entirely (it's optional to
// readGif's parser) so each fixture below stays focused on the one thing
// it's testing.
function buildRawGif({ width, height, minCodeSize, codes, localColorTable }) {
  const chunks = [Buffer.from("GIF89a", "ascii")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80; // global color table present, 2 entries (colorBits=1)
  chunks.push(lsd);
  chunks.push(Buffer.from([10, 20, 30, 40, 50, 60])); // 2 global colors

  const imageDescriptor = Buffer.alloc(10);
  imageDescriptor[0] = 0x2c;
  imageDescriptor.writeUInt16LE(0, 1);
  imageDescriptor.writeUInt16LE(0, 3);
  imageDescriptor.writeUInt16LE(width, 5);
  imageDescriptor.writeUInt16LE(height, 7);
  imageDescriptor[9] = localColorTable ? 0x80 | (localColorTable.bits - 1) : 0;
  chunks.push(imageDescriptor);
  if (localColorTable) chunks.push(localColorTable.bytes);

  chunks.push(Buffer.from([minCodeSize]));
  chunks.push(subBlocks(packCodes(codes)));
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

test.describe("server / gif89a", () => {

test("round-trips a single frame with a minimal 1-color-derived palette", () => {
  const gif = writeGif({
    width: 2,
    height: 2,
    globalColorTable: [{ r: 9, g: 9, b: 9 }],
    frames: [{ pixels: Uint8Array.from([0, 0, 0, 0]) }],
  });
  const back = readGif(gif);
  assert.equal(back.width, 2);
  assert.equal(back.height, 2);
  // Requested table (1 color) padded up to the minimum table size (2);
  // the second slot falls back to {r:0,g:0,b:0} since none was supplied.
  assert.equal(back.globalColorTable.length, 2);
  assert.deepEqual(back.globalColorTable[1], { r: 0, g: 0, b: 0 });
  assert.deepEqual([...back.frames[0].pixels], [0, 0, 0, 0]);
});

test("round-trips a palette that exactly fills its padded table size (no fallback color needed)", () => {
  const palette = [
    { r: 1, g: 2, b: 3 },
    { r: 4, g: 5, b: 6 },
    { r: 7, g: 8, b: 9 },
    { r: 10, g: 11, b: 12 },
  ];
  const gif = writeGif({
    width: 2,
    height: 2,
    globalColorTable: palette,
    frames: [{ pixels: Uint8Array.from([0, 1, 2, 3]) }],
  });
  const back = readGif(gif);
  assert.deepEqual(back.globalColorTable, palette);
  assert.deepEqual([...back.frames[0].pixels], [0, 1, 2, 3]);
});

test("round-trips multiple frames, some with an explicit delay and some without", () => {
  const palette = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }];
  const gif = writeGif({
    width: 2,
    height: 1,
    globalColorTable: palette,
    frames: [
      { pixels: Uint8Array.from([0, 1]), delayCs: 50 },
      { pixels: Uint8Array.from([1, 0]) }, // no delayCs -> defaults to 0
    ],
  });
  const back = readGif(gif);
  assert.equal(back.frames.length, 2);
  assert.equal(back.frames[0].delayCs, 50);
  assert.equal(back.frames[1].delayCs, 0);
  assert.deepEqual([...back.frames[0].pixels], [0, 1]);
  assert.deepEqual([...back.frames[1].pixels], [1, 0]);
});

test("round-trips a large, 256-color frame that forces LZW code-width growth and a mid-stream dictionary reset", () => {
  const width = 90, height = 90; // 8100 pixels: comfortably exceeds the 4096-entry dictionary
  const palette = Array.from({ length: 256 }, (_, i) => ({ r: (i * 37) & 255, g: (i * 59) & 255, b: (i * 97) & 255 }));
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 31 + 7) & 255;
  const gif = writeGif({ width, height, globalColorTable: palette, frames: [{ pixels }] });
  const back = readGif(gif);
  assert.equal(back.globalColorTable.length, 256);
  assert.deepEqual([...back.frames[0].pixels], [...pixels]);
});

test("rejects a buffer that isn't a GIF at all", () => {
  assert.throws(() => readGif(Buffer.from("not a gif at all")), /not a GIF file/);
});

test("decodes a file with no global color table at all, returning an empty palette", () => {
  const chunks = [Buffer.from("GIF89a", "ascii")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(3, 0);
  lsd.writeUInt16LE(1, 2);
  lsd[4] = 0x00; // no global color table
  chunks.push(lsd);
  const imageDescriptor = Buffer.alloc(10);
  imageDescriptor[0] = 0x2c;
  imageDescriptor.writeUInt16LE(3, 5);
  imageDescriptor.writeUInt16LE(1, 7);
  chunks.push(imageDescriptor);
  chunks.push(Buffer.from([2])); // minCodeSize
  chunks.push(subBlocks(packCodes([[4, 3], [0, 3], [1, 3], [5, 3]])));
  chunks.push(Buffer.from([0x3b]));
  const back = readGif(Buffer.concat(chunks));
  assert.deepEqual(back.globalColorTable, []);
  assert.deepEqual([...back.frames[0].pixels], [0, 1, 0]);
});

test("skips a local color table on an image that has one, using the global table for pixel values", () => {
  const gif = buildRawGif({
    width: 3,
    height: 1,
    minCodeSize: 2,
    // clear(4), 0, 1, end(5), each 3 bits wide (minCodeSize+1)
    codes: [[4, 3], [0, 3], [1, 3], [5, 3]],
    localColorTable: { bits: 2, bytes: Buffer.alloc(4 * 3, 1) }, // 4 unused local colors
  });
  const back = readGif(gif);
  assert.equal(back.globalColorTable.length, 2);
  assert.deepEqual([...back.frames[0].pixels], [0, 1, 0]);
});

test("throws on an unrecognized block marker instead of looping forever", () => {
  const gif = buildRawGif({ width: 1, height: 1, minCodeSize: 2, codes: [[4, 3], [0, 3], [5, 3]] });
  const corrupted = Buffer.from(gif);
  const trailerIndex = corrupted.length - 1;
  assert.equal(corrupted[trailerIndex], 0x3b);
  corrupted[trailerIndex] = 0x99; // replace the trailer with an unknown marker
  assert.throws(() => readGif(corrupted), /unexpected block marker 0x99/);
});

test("decodes the classic LZW back-reference (KwKwK) case, matching a real decoder's table growth", () => {
  // clear(4), literal 0, then a code equal to the not-yet-assigned nextCode
  // (6) while a previous entry exists -- the one case gif89a.ts's own
  // encoder never emits (it's literal-only) but any spec-compliant decoder
  // must still handle, since a real GIF-writing tool can emit it.
  const gif = buildRawGif({
    width: 3,
    height: 1,
    minCodeSize: 2,
    codes: [[4, 3], [0, 3], [6, 3], [5, 3]],
  });
  const back = readGif(gif);
  assert.deepEqual([...back.frames[0].pixels], [0, 0, 0]);
});

test("a KwKwK-decoded entry that overflows the declared pixel count is truncated, not overrun", () => {
  // Same crafted stream as above, but the image only declares 1 pixel while
  // the decoded entry produces 2 -- exercises the bounds guard that stops
  // writing past the pre-sized output buffer without throwing.
  const gif = buildRawGif({
    width: 1,
    height: 1,
    minCodeSize: 2,
    codes: [[4, 3], [0, 3], [6, 3], [5, 3]],
  });
  const back = readGif(gif);
  assert.equal(back.frames[0].pixels.length, 1);
  assert.deepEqual([...back.frames[0].pixels], [0]);
});

test("throws on a code that is neither a known dictionary entry nor the KwKwK case", () => {
  const gif = buildRawGif({
    width: 1,
    height: 1,
    minCodeSize: 2,
    codes: [[4, 3], [7, 3]], // 7 is unused and isn't nextCode (6) with no prior entry
  });
  assert.throws(() => readGif(gif), /invalid LZW code 7/);
});

test("tolerates a stream that ends immediately after a clear code, without throwing", () => {
  // codeSize is byte-aligned here (minCodeSize=7 -> codeSize=8), so the
  // clear code exactly exhausts the one available byte with zero bits left
  // over -- readCode's "no data and nothing buffered" branch, distinct from
  // running out mid-code with a partial byte still buffered (next test).
  const gif = buildRawGif({
    width: 2,
    height: 1,
    minCodeSize: 7,
    codes: [[128, 8]], // clearCode = 1 << 7 = 128
  });
  const back = readGif(gif);
  assert.deepEqual([...back.frames[0].pixels], [0, 0]);
});

test("tolerates a stream that runs out with a partial, insufficient-width byte still buffered", () => {
  // clear(4) + literal 0 leaves exactly 2 leftover bits in the single
  // supplied byte -- not enough for another 3-bit code, so readCode returns
  // a zero-extended code from those leftover bits instead of requesting
  // more data, decodes one more (repeated) pixel, grows the dictionary, and
  // only then runs out for good.
  const gif = buildRawGif({
    width: 2,
    height: 1,
    minCodeSize: 2,
    codes: [[4, 3], [0, 3]],
  });
  const back = readGif(gif);
  assert.deepEqual([...back.frames[0].pixels], [0, 0]);
});

});
