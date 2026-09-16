import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { crc32 as zlibCrc32, deflateSync, inflateSync } from "node:zlib";

// PngSpeak (https://github.com/defcron/pngspeak) embeds arbitrary bytes
// directly as RGBA pixel data inside a PNG: every 4 bytes of input becomes
// one pixel, laid out row-major across a grid, written as an *uncompressed*
// (filter type 0) scanline stream that's then zlib-deflated the normal PNG
// way. The original byte length is stashed in a "license"-keyed iTXt chunk
// using a small custom scheme (hex-encode the length, then hex-encode the
// *length of that hex string* as a second header field) so decoding knows
// where to stop trimming padding. There's also a deliberately lossy "art"
// mode: encoding at a small grid size and then upscaling with bilinear
// interpolation destroys the embedded data on purpose, purely for visual
// output -- ported here faithfully (same formulas as the reference
// implementation) but, being lossy by design, isn't meant to round-trip.
//
// This module is a straight port of `.pngspeak/__main__.py`'s `encode`/
// `decode`, kept byte-for-byte compatible with it for the non-upscaled path
// (verified against the real Python script, not just eyeballed).

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BPP = 4; // RGBA

export interface PngSpeakEncodeOptions {
  /** Fixed grid width in pixels. Derived from the data size if omitted. */
  width?: number;
  /** Fixed grid height in pixels. Derived from the data size if omitted. */
  height?: number;
  /** Pad or truncate the input to exactly this many bytes before embedding. */
  length?: number;
  /** Source for padding bytes: a file path, a string to repeat, or "" for random. Defaults to random. */
  rand?: string;
  /**
   * Whether `rand` may be treated as a filesystem path (the reference CLI's
   * own behavior). Defaults to true for library/CLI-parity callers; the HTTP
   * API layer explicitly passes false so a caller-supplied `rand` string can
   * never trigger an arbitrary local file read.
   */
  randAllowFilePath?: boolean;
  /** Upscale the final image to this width using lossy bilinear interpolation ("art mode"). */
  upscaleWidth?: number;
  /** Upscale the final image to this height using lossy bilinear interpolation ("art mode"). */
  upscaleHeight?: number;
}

export interface PngSpeakDecodeOptions {
  /** Override the embedded length (skip/replace the iTXt header's value). */
  length?: number;
  /** Source for padding bytes if the requested length exceeds what's embedded. */
  rand?: string;
  /** See {@link PngSpeakEncodeOptions.randAllowFilePath}. */
  randAllowFilePath?: boolean;
}

// Every call site only invokes this with n > 0 (padding/truncation math
// upstream guarantees it), and the logic below already degrades correctly
// to an empty buffer for n === 0 on its own, so there's no separate n <= 0
// guard here to keep -- it would be untestable dead code.
function readBytesFromSource(n: number, randSource: string | undefined, allowFilePath = true): Buffer {
  if (randSource !== undefined) {
    if (allowFilePath && existsSync(randSource)) {
      return readFileSync(randSource).subarray(0, n);
    }
    const encoded = Buffer.from(randSource, "utf8");
    if (encoded.length === 0) return randomBytes(n);
    const repeated = Buffer.concat(Array(Math.ceil(n / encoded.length) + 1).fill(encoded));
    return repeated.subarray(0, n);
  }
  return randomBytes(n);
}

function chunkCrc(chunkType: Buffer, data: Buffer): Buffer {
  const value = zlibCrc32(Buffer.concat([chunkType, data])) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

function writeChunk(chunks: Buffer[], chunkType: string, data: Buffer): void {
  const typeBuf = Buffer.from(chunkType, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  chunks.push(length, typeBuf, data, chunkCrc(typeBuf, data));
}

/**
 * Minimal big-endian byte encoding of a non-negative integer, matching
 * Python's `int.to_bytes((n.bit_length()+7)//8 or 1, "big")`. Bit length is
 * derived from the hex string's own digit count rather than
 * `Math.log2`/`Math.floor` -- log2 of an exact power of two (e.g. 65536) can
 * land a hair below the true integer due to floating-point rounding, which
 * would silently produce a one-byte-short header field for those values.
 */
function minimalBigEndianHex(value: number): string {
  // Math.clz32 operates on the exact 32-bit integer representation (no
  // floating-point rounding involved anywhere), unlike a log2-based bit
  // length which can land a hair below the true value for an exact power of
  // two and silently produce a one-byte-short header field.
  const bitLength = value === 0 ? 0 : 32 - Math.clz32(value);
  const byteLength = Math.floor((bitLength + 7) / 8) || 1;
  return value.toString(16).padStart(byteLength * 2, "0");
}

// Python's built-in round() rounds half-to-even ("banker's rounding");
// Math.round() rounds half-away-from-zero. They agree everywhere except
// exact .5 fractions, which the bilinear blend produces often enough
// (integer pixel inputs blended with rational weights) that this needs its
// own function to stay byte-identical with the reference implementation.
export function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function bilinearUpscale(data: Buffer, width: number, height: number, uw: number, uh: number): Buffer {
  const result = Buffer.alloc(uw * uh * BPP);
  const getPixel = (x: number, y: number): number[] => {
    const offset = (y * width + x) * BPP;
    return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
  };
  for (let outY = 0; outY < uh; outY++) {
    for (let outX = 0; outX < uw; outX++) {
      const srcX = ((outX + 0.5) * width) / uw - 0.5;
      const srcY = ((outY + 0.5) * height) / uh - 0.5;
      // Python's `int()` truncates toward zero, unlike Math.floor (which
      // floors toward -Infinity) -- they disagree exactly when srcX/srcY is
      // negative (always possible here: (0+0.5)*width/uw - 0.5 goes negative
      // whenever uw > width), so Math.trunc is required for pixel parity.
      let x0 = Math.trunc(srcX);
      let y0 = Math.trunc(srcY);
      const x1 = Math.min(x0 + 1, width - 1);
      const y1 = Math.min(y0 + 1, height - 1);
      x0 = Math.max(0, x0);
      y0 = Math.max(0, y0);
      const dx = srcX - x0;
      const dy = srcY - y0;
      const p00 = getPixel(x0, y0);
      const p10 = getPixel(x1, y0);
      const p01 = getPixel(x0, y1);
      const p11 = getPixel(x1, y1);
      const outOffset = (outY * uw + outX) * BPP;
      for (let c = 0; c < BPP; c++) {
        const top = p00[c] * (1 - dx) + p10[c] * dx;
        const bottom = p01[c] * (1 - dx) + p11[c] * dx;
        const value = top * (1 - dy) + bottom * dy;
        result[outOffset + c] = Math.max(0, Math.min(255, pythonRound(value)));
      }
    }
  }
  return result;
}

/** Resolves the pixel grid's width/height from CLI-style optional overrides, matching the reference implementation's branch-by-branch defaulting. */
function computeGridDimensions(pixelsNeeded: number, width: number | undefined, height: number | undefined): [number, number] {
  if (width === undefined && height === undefined) {
    const w = Math.max(1, Math.floor(Math.sqrt(pixelsNeeded)));
    const h = Math.max(1, Math.ceil(pixelsNeeded / w));
    return [w, h];
  }
  if (width === undefined) {
    const h = height! <= 0 ? 1 : height!;
    const w = Math.max(1, Math.ceil(pixelsNeeded / h));
    return [w, h];
  }
  if (height === undefined) {
    const w = width <= 0 ? 1 : width;
    const h = Math.max(1, Math.ceil(pixelsNeeded / w));
    return [w, h];
  }
  return [width <= 0 ? 1 : width, height <= 0 ? 1 : height];
}

/** Encodes arbitrary bytes into a PngSpeak PNG. */
export function encodePngSpeak(input: Buffer, options: PngSpeakEncodeOptions = {}): Buffer {
  const actualLength = input.length;
  let lengthForHeader: number;
  let dataToEmbed: Buffer;
  if (options.length !== undefined) {
    lengthForHeader = options.length;
    if (actualLength < options.length) {
      dataToEmbed = Buffer.concat([input, readBytesFromSource(options.length - actualLength, options.rand, options.randAllowFilePath ?? true)]);
    } else if (actualLength > options.length) {
      dataToEmbed = input.subarray(0, options.length);
    } else {
      dataToEmbed = input;
    }
  } else {
    lengthForHeader = actualLength;
    dataToEmbed = input;
  }

  const pixelsNeeded = Math.max(1, Math.ceil(dataToEmbed.length / BPP));
  const gridDimensions = computeGridDimensions(pixelsNeeded, options.width, options.height);
  const gridW = gridDimensions[0];
  const gridH = gridDimensions[1];

  const gridCapacity = gridW * gridH * BPP;
  let finalPixelData = dataToEmbed;
  if (finalPixelData.length < gridCapacity) {
    finalPixelData = Buffer.concat([finalPixelData, readBytesFromSource(gridCapacity - finalPixelData.length, options.rand, options.randAllowFilePath ?? true)]);
  } else if (finalPixelData.length > gridCapacity) {
    finalPixelData = finalPixelData.subarray(0, gridCapacity);
  }

  const chunks: Buffer[] = [PNG_SIGNATURE];

  // `||`, not `??`, on purpose: matches the reference's `uw if uw else
  // grid_w` (Python truthiness, so an explicit 0 also falls back to grid_w)
  // -- this faithfully reproduces the encoder's own dimension-mismatch bug
  // when only one of upscaleWidth/upscaleHeight is given (see bilinear
  // upscale gating below, which requires *both* to be truthy).
  const ihdrW = options.upscaleWidth || gridW;
  const ihdrH = options.upscaleHeight || gridH;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ihdrW, 0);
  ihdr.writeUInt32BE(ihdrH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  writeChunk(chunks, "IHDR", ihdr);

  const hexValueForHeader = minimalBigEndianHex(lengthForHeader);
  const lenOfPart2InBytes = Buffer.byteLength(hexValueForHeader, "utf8");
  const hexLenOfPart2 = minimalBigEndianHex(lenOfPart2InBytes);
  const itxtText = `${hexLenOfPart2} ${hexValueForHeader}`;
  const itxtKeywordAndParams = Buffer.from("license\x00\x00\x00\x00\x00", "latin1");
  writeChunk(chunks, "iTXt", Buffer.concat([itxtKeywordAndParams, Buffer.from(itxtText, "utf8")]));

  let dataForIdat = finalPixelData;
  let idatW = gridW;
  let idatH = gridH;
  if (options.upscaleWidth && options.upscaleHeight) {
    dataForIdat = bilinearUpscale(finalPixelData, gridW, gridH, options.upscaleWidth, options.upscaleHeight);
    idatW = options.upscaleWidth;
    idatH = options.upscaleHeight;
  }

  const rowBytes = idatW * BPP;
  const raw = Buffer.alloc(idatH * (rowBytes + 1));
  for (let y = 0; y < idatH; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0; // filter type: none
    dataForIdat.copy(raw, rowStart + 1, y * rowBytes, y * rowBytes + rowBytes);
  }
  writeChunk(chunks, "IDAT", deflateSync(raw));
  writeChunk(chunks, "IEND", Buffer.alloc(0));

  return Buffer.concat(chunks);
}

interface PngChunk {
  type: string;
  data: Buffer;
}

function readChunks(png: Buffer): PngChunk[] {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("pngspeak: not a PNG file (bad signature)");
  }
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4; // length + type + data + crc
    if (type === "IEND") break;
  }
  return chunks;
}

/** Decodes a PngSpeak PNG back into its embedded bytes. Not meaningful for an "art mode" (upscaled) image -- that path is intentionally lossy. */
export function decodePngSpeak(png: Buffer, options: PngSpeakDecodeOptions = {}): Buffer {
  const chunks = readChunks(png);
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  let decodedLengthFromHeader: number | undefined;

  for (const chunk of chunks) {
    if (chunk.type === "IHDR") {
      width = chunk.data.readUInt32BE(0);
      height = chunk.data.readUInt32BE(4);
    } else if (chunk.type === "IDAT") {
      idatParts.push(chunk.data);
    } else if (chunk.type === "iTXt" && decodedLengthFromHeader === undefined) {
      const nullPositions: number[] = [];
      for (let i = 0; i < chunk.data.length && nullPositions.length < 5; i++) {
        if (chunk.data[i] === 0) nullPositions.push(i);
      }
      if (nullPositions.length >= 4) {
        const keyword = chunk.data.subarray(0, nullPositions[0]).toString("utf8");
        if (keyword === "license") {
          const textStart = nullPositions[4] + 1;
          const text = chunk.data.subarray(textStart).toString("utf8").trim();
          const parts = text.split(" ");
          if (parts.length === 2) {
            decodedLengthFromHeader = parseInt(parts[1], 16);
          }
        }
      }
    }
  }

  const decompressed = inflateSync(Buffer.concat(idatParts));
  const rowSize = 1 + width * BPP;
  const pixelData = Buffer.alloc(height * width * BPP);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    decompressed.copy(pixelData, y * width * BPP, rowStart + 1, rowStart + rowSize);
  }

  const finalLengthTarget = options.length ?? decodedLengthFromHeader;
  const maxEmbeddedBytes = width * height * BPP;

  if (finalLengthTarget === undefined) return pixelData.subarray(0, maxEmbeddedBytes);
  if (finalLengthTarget <= maxEmbeddedBytes) return pixelData.subarray(0, finalLengthTarget);
  const padding = readBytesFromSource(finalLengthTarget - maxEmbeddedBytes, options.rand, options.randAllowFilePath ?? true);
  return Buffer.concat([pixelData.subarray(0, maxEmbeddedBytes), padding]);
}
