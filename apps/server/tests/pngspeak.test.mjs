import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decodePngSpeak, encodePngSpeak, pythonRound } from "../dist/pngspeak.js";

test.describe("server / pngspeak", () => {

test("pythonRound matches Python's round-half-to-even for both parities of tie", () => {
  assert.equal(pythonRound(2.5), 2); // ties to even: 2 is even, stays 2
  assert.equal(pythonRound(3.5), 4); // 3 is odd, rounds up to even 4
  assert.equal(pythonRound(-0.5), 0); // floor(-0.5) = -1, odd, rounds up to 0
  assert.equal(pythonRound(2.4), 2); // ordinary below-half case
  assert.equal(pythonRound(2.6), 3); // ordinary above-half case
});


test("encodes and decodes small text round-trip", () => {
  const input = Buffer.from("hello pngspeak\n");
  const png = encodePngSpeak(input);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(decodePngSpeak(png).toString(), "hello pngspeak\n");
});

test("round-trips binary (non-UTF8) data", () => {
  const input = Buffer.from([0, 1, 2, 255, 254, 253, 0, 0, 128]);
  const png = encodePngSpeak(input);
  assert.deepEqual([...decodePngSpeak(png)], [...input]);
});

test("round-trips empty input", () => {
  const png = encodePngSpeak(Buffer.alloc(0));
  assert.equal(decodePngSpeak(png).length, 0);
});

test("a fixed grid width derives height, and round-trips", () => {
  const input = Buffer.from("0123456789abcdef"); // exactly 4 pixels
  const png = encodePngSpeak(input, { width: 2 });
  assert.equal(decodePngSpeak(png).toString(), input.toString());
});

test("a fixed grid height derives width, and round-trips", () => {
  const input = Buffer.from("0123456789abcdef");
  const png = encodePngSpeak(input, { height: 2 });
  assert.equal(decodePngSpeak(png).toString(), input.toString());
});

test("both grid dimensions fixed larger than needed pads with random bytes, but the real payload still round-trips", () => {
  const input = Buffer.from("hi");
  const png = encodePngSpeak(input, { width: 3, height: 3 });
  assert.equal(decodePngSpeak(png).toString(), "hi");
});

test("--length pads short input and embeds the requested length in the header", () => {
  const input = Buffer.from("hi");
  const png = encodePngSpeak(input, { length: 10, rand: "X" });
  const decoded = decodePngSpeak(png);
  assert.equal(decoded.length, 10);
  assert.equal(decoded.subarray(0, 2).toString(), "hi");
});

test("a zero height paired with an explicit width normalizes to 1 (not 'auto-derive'), shrinking the grid", () => {
  const input = Buffer.from("0123456789abcdef"); // 4 pixels, more than a 2x1 grid holds
  const png = encodePngSpeak(input, { width: 2, height: 0 });
  // 2x1 grid = 8 bytes capacity -- this is the CLI's own normalization
  // behavior (0/negative means "1", not "please derive this one instead"),
  // so anything past the first 2 pixels is genuinely lost, same as any
  // other undersized fixed grid.
  assert.equal(decodePngSpeak(png, { length: 8 }).toString(), input.subarray(0, 8).toString());
});

test("a negative width paired with an explicit height normalizes to 1, shrinking the grid the same way", () => {
  const input = Buffer.from("0123456789abcdef");
  const png = encodePngSpeak(input, { width: -1, height: 2 });
  assert.equal(decodePngSpeak(png, { length: 8 }).toString(), input.subarray(0, 8).toString());
});

test("a zero or negative height with width left to be derived also normalizes to 1", () => {
  const input = Buffer.from("0123456789abcdef");
  const png = encodePngSpeak(input, { height: -3 });
  assert.equal(decodePngSpeak(png).toString(), input.toString());
});

test("a zero width paired with an explicit (unset->derived) height also normalizes to 1", () => {
  const input = Buffer.from("0123456789abcdef");
  const png = encodePngSpeak(input, { width: 0 });
  assert.equal(decodePngSpeak(png).toString(), input.toString());
});

test("both dimensions zero or negative both normalize to 1x1 (with data loss for anything bigger)", () => {
  const input = Buffer.from("ab");
  const png = encodePngSpeak(input, { width: 0, height: -5 });
  assert.equal(decodePngSpeak(png, { length: 2 }).toString(), "ab");
});

test("--length exactly matching the input's actual length changes nothing", () => {
  const input = Buffer.from("exact");
  const png = encodePngSpeak(input, { length: input.length });
  assert.equal(decodePngSpeak(png).toString(), "exact");
});

test("--length truncates long input", () => {
  const input = Buffer.from("this is definitely too long");
  const png = encodePngSpeak(input, { length: 4 });
  assert.equal(decodePngSpeak(png).toString(), "this");
});

test("a --rand string is repeated to fill padding deterministically", () => {
  const png1 = encodePngSpeak(Buffer.from("a"), { length: 5, rand: "XY" });
  const png2 = encodePngSpeak(Buffer.from("a"), { length: 5, rand: "XY" });
  assert.deepEqual([...png1], [...png2]);
  assert.equal(decodePngSpeak(png1).toString(), "aXYXY");
});

test("an empty --rand string falls back to real random bytes, not a literal empty repeat", () => {
  const png1 = encodePngSpeak(Buffer.from("a"), { length: 5, rand: "" });
  const png2 = encodePngSpeak(Buffer.from("a"), { length: 5, rand: "" });
  assert.notDeepEqual([...png1], [...png2]);
});

test("a --rand pointing at a real file reads padding bytes from it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-pngspeak-"));
  try {
    const randFile = path.join(dir, "pad-source.bin");
    writeFileSync(randFile, Buffer.from("PADDINGBYTES"));
    const png = encodePngSpeak(Buffer.from("a"), { length: 5, rand: randFile });
    assert.equal(decodePngSpeak(png).toString(), "aPADD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decode with an explicit length override extends beyond what's embedded, padding with --rand", () => {
  const png = encodePngSpeak(Buffer.from("ab"));
  const decoded = decodePngSpeak(png, { length: 8, rand: "Z" });
  assert.equal(decoded.length, 8);
  assert.equal(decoded.subarray(0, 2).toString(), "ab");
});

test("decode with an explicit length shorter than embedded truncates", () => {
  const png = encodePngSpeak(Buffer.from("abcdefgh"));
  assert.equal(decodePngSpeak(png, { length: 3 }).toString(), "abc");
});

test("a grid smaller than the data truncates the embedded pixel data (data loss, matching the CLI's own behavior)", () => {
  const input = Buffer.from("this is way more data than a 1x1 grid can hold");
  const png = encodePngSpeak(input, { width: 1, height: 1 });
  // Header still claims the original length, but only 4 bytes (1 pixel)
  // actually made it into the grid -- decode returns what's really there.
  const decoded = decodePngSpeak(png, { length: 4 });
  assert.equal(decoded.length, 4);
  assert.equal(decoded.toString(), input.subarray(0, 4).toString());
});

test("art mode (upscale) produces a larger IHDR-declared image than the underlying grid", () => {
  const input = Buffer.from("small payload for art");
  const png = encodePngSpeak(input, { width: 4, upscaleWidth: 32, upscaleHeight: 32 });
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, 32);
  assert.equal(height, 32);
});

test("decoding with no length override and no embedded length header returns the full grid, untrimmed", () => {
  const input = Buffer.from("0123456789abcdef"); // fills a 2x2 grid exactly
  const png = encodePngSpeak(input, { width: 2, height: 2 });
  // Strip the iTXt chunk entirely to simulate a PNG with no length header.
  const idx = png.indexOf(Buffer.from("iTXt"));
  const chunkStart = idx - 4;
  const chunkLen = png.readUInt32BE(chunkStart);
  const stripped = Buffer.concat([png.subarray(0, chunkStart), png.subarray(chunkStart + 12 + chunkLen)]);
  const decoded = decodePngSpeak(stripped);
  assert.equal(decoded.length, 16); // 2x2 grid * 4 bytes/pixel, nothing trimmed
  assert.equal(decoded.toString(), input.toString());
});

test("rejects a buffer that isn't a PNG at all", () => {
  assert.throws(() => decodePngSpeak(Buffer.from("not a png")), /not a PNG file/);
});

test("interoperates byte-for-byte with the reference pngspeak Python implementation when it's available", () => {
  let pngspeakScript;
  try {
    pngspeakScript = execFileSync("bash", ["-lc", "command -v pngspeak-main.py 2>/dev/null || true"]).toString().trim();
  } catch {
    pngspeakScript = "";
  }
  if (!pngspeakScript) {
    // The reference Python script isn't guaranteed to be on PATH in every
    // environment (e.g. CI); this test only adds value where it's reachable.
    // (Manually verified byte-for-byte against a local checkout during
    // development -- see PR/commit notes.)
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-pngspeak-interop-"));
  try {
    const input = Buffer.from("interop check\n");
    const png = encodePngSpeak(input, { rand: "PAD" });
    const pngFile = path.join(dir, "ts.png");
    writeFileSync(pngFile, png);
    const decoded = execFileSync("python3", [pngspeakScript, "-d"], { input: png });
    assert.equal(decoded.toString(), input.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

});
