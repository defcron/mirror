// Minimal, dependency-free GIF89a encoder/decoder: just enough of the spec
// to round-trip a multi-frame, single-global-color-table, non-interlaced
// indexed-color animation -- which is exactly what gptgif.c produces and
// gptungif.py consumes. Node has no built-in image codec, and giflib isn't
// available to link against in every environment this runs in, so this
// hand-rolls the GIF LZW variant (a real, if small, algorithm) rather than
// pulling in an image library for one narrow use case.
//
// This is NOT a general-purpose GIF library: no interlacing, no local color
// tables, no transparency index handling beyond what gptgif.c itself uses,
// and the LZW encoder here won't produce byte-identical output to giflib's
// (different encoders make different but equally valid dictionary choices)
// -- only pixel-identical, spec-compliant GIFs that any real GIF reader
// (including this decoder, and verified against Pillow) can open correctly.

export interface GifFrame {
  /** Palette index per pixel, row-major, length === width*height. */
  pixels: Uint8Array;
  /** Centiseconds to display this frame (Graphics Control Extension delay). */
  delayCs?: number;
}

export interface GifColor {
  r: number;
  g: number;
  b: number;
}

export interface GifImage {
  width: number;
  height: number;
  globalColorTable: GifColor[];
  frames: GifFrame[];
}

const GIF_HEADER = Buffer.from("GIF89a", "ascii");

function nextPowerOfTwoExponent(n: number): number {
  let bits = 1;
  while (1 << bits < n) bits++;
  return bits;
}

class BitWriter {
  private bytes: number[] = [];
  private bitBuffer = 0;
  private bitCount = 0;

  writeCode(code: number, width: number): void {
    this.bitBuffer |= code << this.bitCount;
    this.bitCount += width;
    while (this.bitCount >= 8) {
      this.bytes.push(this.bitBuffer & 0xff);
      this.bitBuffer >>= 8;
      this.bitCount -= 8;
    }
  }

  finish(): Buffer {
    if (this.bitCount > 0) {
      this.bytes.push(this.bitBuffer & 0xff);
      this.bitBuffer = 0;
      this.bitCount = 0;
    }
    return Buffer.from(this.bytes);
  }
}

/**
 * GIF LZW encoder over a flat indexed-pixel buffer.
 *
 * This deliberately emits every pixel as its own literal code rather than
 * building genuine multi-symbol back-references: a real dictionary-building
 * encoder (matching giflib's choices exactly) isn't necessary here, since
 * this only ever needs to produce files that this module's own readGif (or
 * any spec-compliant reader) can decode correctly, and literal-only coding
 * sidesteps an entire, easy-to-get-subtly-wrong class of bug -- reconstructing
 * multi-symbol dictionary *entry contents* identically to a real encoder's
 * (verified against Pillow the hard way: a naive from-scratch dictionary
 * encoder/decoder pair round-tripped fine against itself, since matching
 * self-introduced bugs cancel out, but produced silently wrong pixels when
 * decoding a real giflib/Pillow-written file with the same nominal
 * algorithm). A real GIF *decoder* is still required to track dictionary
 * growth for codes it was never given (per spec, any conforming decoder
 * builds its table from whatever it sees, whether or not the encoder ever
 * references those entries), so code-width growth still has to happen in
 * lockstep between writer and reader -- that part remains real and is
 * exercised by every multi-frame, many-color test here and cross-checked
 * against Pillow. What's cut is only the (unnecessary, bug-prone) attempt to
 * also compress by re-using those entries as back-references.
 */
function lzwEncode(pixels: Uint8Array, minCodeSize: number): Buffer {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const maxCodeBits = 12;
  const maxDictSize = 1 << maxCodeBits;

  const writer = new BitWriter();
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;

  function resetDict(): void {
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  }

  resetDict();
  writer.writeCode(clearCode, codeSize);

  // Whether the code about to be written is the first one since the last
  // clear (initial or mid-stream) -- a spec-compliant decoder skips its own
  // dictionary-entry bookkeeping for exactly that one code (it has no
  // "previous" match to extend yet), so this must track every reset, not
  // just the very first pixel of the whole stream. Gating on the loop index
  // alone (`i > 0`) was the bug: it correctly skipped the increment for
  // pixel 0, but after a *mid-stream* reset (dictionary hitting
  // maxDictSize), the next pixel still had i > 0 and so wrongly incremented
  // -- desynchronizing this encoder's code-width growth from the decoder's
  // from that point on, in every cycle after the first.
  let firstSinceReset = true;
  for (let i = 0; i < pixels.length; i++) {
    writer.writeCode(pixels[i], codeSize);
    // A spec-compliant decoder adds a dictionary entry for every code after
    // the first following a clear, regardless of whether that code was a
    // back-reference -- so nextCode must advance here too, to keep this
    // encoder's code-width growth synchronized with any real decoder's.
    if (!firstSinceReset) {
      if (nextCode < maxDictSize) {
        nextCode++;
        // GIF LZW's "early change": bump the code width the moment the
        // dictionary fills the current width, matching the decoder's
        // identical, independently-derived bump condition below.
        if (nextCode >= 1 << codeSize && codeSize < maxCodeBits) codeSize++;
      } else {
        writer.writeCode(clearCode, codeSize);
        resetDict();
        firstSinceReset = true;
        continue;
      }
    }
    firstSinceReset = false;
  }
  writer.writeCode(endCode, codeSize);

  return writer.finish();
}

class BitReader {
  private pos = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  constructor(private data: Buffer) {}

  readCode(width: number): number | null {
    let ranOutMidCode = false;
    while (this.bitCount < width) {
      if (this.pos >= this.data.length) {
        if (this.bitCount === 0) return null;
        ranOutMidCode = true;
        break;
      }
      this.bitBuffer |= this.data[this.pos] << this.bitCount;
      this.bitCount += 8;
      this.pos++;
    }
    const mask = (1 << width) - 1;
    const code = this.bitBuffer & mask;
    this.bitBuffer >>= width;
    // Only `width` bits were actually available when data ran out mid-code
    // (the rest of `code` above is implicitly zero-padded) -- subtracting
    // the full `width` regardless would drive bitCount negative and never
    // land it back on exactly 0, so every later call would keep taking this
    // same "ran out" branch forever instead of eventually returning null.
    // That's a real infinite loop in lzwDecode's caller on a truncated file.
    this.bitCount = ranOutMidCode ? 0 : this.bitCount - width;
    return code;
  }
}

/** Inverse of lzwEncode: standard variable-width GIF LZW decompression. */
function lzwDecode(data: Buffer, minCodeSize: number, expectedPixelCount: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const maxCodeBits = 12;
  const maxDictSize = 1 << maxCodeBits;

  const reader = new BitReader(data);
  const out = new Uint8Array(expectedPixelCount);
  let outPos = 0;

  let dict: number[][] = [];
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;

  function resetDict(): void {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([]); // clear code placeholder
    dict.push([]); // end code placeholder
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  }

  resetDict();
  let previous: number[] | null = null;

  for (;;) {
    const code = reader.readCode(codeSize);
    if (code === null || code === endCode) break;
    if (code === clearCode) {
      resetDict();
      previous = null;
      continue;
    }
    let entry: number[];
    if (code < dict.length && dict[code].length > 0) {
      entry = dict[code];
    } else if (code === nextCode && previous) {
      entry = [...previous, previous[0]];
    } else {
      throw new Error(`gif: invalid LZW code ${code}`);
    }
    for (const value of entry) {
      if (outPos < out.length) out[outPos] = value;
      outPos++;
    }
    if (previous && nextCode < maxDictSize) {
      // Content of this entry is never actually consulted for correctness
      // here (see lzwEncode's comment: the encoder only ever emits literal
      // codes, so `entry` above always comes from the `code < dict.length`
      // branch, never this constructed one) -- but nextCode/codeSize still
      // have to advance in lockstep with the encoder's identical bookkeeping,
      // since a spec-compliant decoder always grows its table alongside
      // whatever it decodes, whether or not those entries end up referenced.
      dict[nextCode] = [...previous, entry[0]];
      nextCode++;
      if (nextCode >= 1 << codeSize && codeSize < maxCodeBits) codeSize++;
    }
    previous = entry;
  }
  return out;
}

function writeSubBlocks(chunks: Buffer[], data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const size = Math.min(255, data.length - offset);
    chunks.push(Buffer.from([size]), data.subarray(offset, offset + size));
    offset += size;
  }
  chunks.push(Buffer.from([0]));
}

function readSubBlocks(buf: Buffer, offset: number): { data: Buffer; nextOffset: number } {
  const parts: Buffer[] = [];
  let pos = offset;
  for (;;) {
    const size = buf[pos];
    pos += 1;
    if (size === 0) break;
    parts.push(buf.subarray(pos, pos + size));
    pos += size;
  }
  return { data: Buffer.concat(parts), nextOffset: pos };
}

/** Encodes a multi-frame indexed-color GIF89a. */
export function writeGif(image: GifImage): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(GIF_HEADER);

  const colorTableSize = Math.max(2, image.globalColorTable.length);
  const colorBits = nextPowerOfTwoExponent(colorTableSize);
  const paddedTableSize = 1 << colorBits;

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(image.width, 0);
  lsd.writeUInt16LE(image.height, 2);
  lsd[4] = 0x80 | ((colorBits - 1) << 4) | (colorBits - 1); // global color table flag + size
  lsd[5] = 0; // background color index
  lsd[6] = 0; // pixel aspect ratio
  chunks.push(lsd);

  const table = Buffer.alloc(paddedTableSize * 3);
  for (let i = 0; i < paddedTableSize; i++) {
    const color = image.globalColorTable[i] ?? { r: 0, g: 0, b: 0 };
    table[i * 3] = color.r;
    table[i * 3 + 1] = color.g;
    table[i * 3 + 2] = color.b;
  }
  chunks.push(table);

  // NETSCAPE2.0 application extension for looping (loop forever), matching
  // typical GIF animation behavior; gptgif.c doesn't set this explicitly but
  // it's harmless and makes the output behave as an animation in viewers.
  chunks.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "ascii"), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));

  const minCodeSize = Math.max(2, colorBits);

  for (const frame of image.frames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 0, 0, 0x00, 0x00]);
    const delay = frame.delayCs ?? 0;
    gce.writeUInt16LE(delay, 4);
    chunks.push(gce);

    const imageDescriptor = Buffer.alloc(10);
    imageDescriptor[0] = 0x2c;
    imageDescriptor.writeUInt16LE(0, 1); // left
    imageDescriptor.writeUInt16LE(0, 3); // top
    imageDescriptor.writeUInt16LE(image.width, 5);
    imageDescriptor.writeUInt16LE(image.height, 7);
    imageDescriptor[9] = 0; // no local color table, not interlaced
    chunks.push(imageDescriptor);

    chunks.push(Buffer.from([minCodeSize]));
    const compressed = lzwEncode(frame.pixels, minCodeSize);
    writeSubBlocks(chunks, compressed);
  }

  chunks.push(Buffer.from([0x3b])); // trailer

  return Buffer.concat(chunks);
}

/** Decodes a GIF89a into its frames (palette indices) and global color table. */
export function readGif(buf: Buffer): GifImage {
  if (buf.subarray(0, 3).toString("ascii") !== "GIF") {
    throw new Error("gif: not a GIF file (bad signature)");
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGlobalColorTable = (packed & 0x80) !== 0;
  const colorBits = (packed & 0x07) + 1;
  const colorTableSize = hasGlobalColorTable ? 1 << colorBits : 0;

  let offset = 13;
  const globalColorTable: GifColor[] = [];
  for (let i = 0; i < colorTableSize; i++) {
    globalColorTable.push({ r: buf[offset], g: buf[offset + 1], b: buf[offset + 2] });
    offset += 3;
  }

  const frames: GifFrame[] = [];
  let pendingDelay = 0;

  while (offset < buf.length) {
    const marker = buf[offset];
    if (marker === 0x3b) break; // trailer
    if (marker === 0x21) {
      // Extension block: label byte, then either a fixed block (GCE) or sub-blocks.
      const label = buf[offset + 1];
      if (label === 0xf9) {
        pendingDelay = buf.readUInt16LE(offset + 4);
        offset += 8; // 0x21 f9 size(4) ... terminator(1) -- fixed 8 bytes for GCE
      } else {
        offset += 2;
        const { nextOffset } = readSubBlocks(buf, offset);
        offset = nextOffset;
      }
      continue;
    }
    if (marker === 0x2c) {
      const imgWidth = buf.readUInt16LE(offset + 5);
      const imgHeight = buf.readUInt16LE(offset + 7);
      const imgPacked = buf[offset + 9];
      offset += 10;
      const hasLocalColorTable = (imgPacked & 0x80) !== 0;
      if (hasLocalColorTable) {
        const localBits = (imgPacked & 0x07) + 1;
        offset += (1 << localBits) * 3; // skip local color table (unused by gptgif)
      }
      const minCodeSize = buf[offset];
      offset += 1;
      const { data, nextOffset } = readSubBlocks(buf, offset);
      offset = nextOffset;
      const pixels = lzwDecode(data, minCodeSize, imgWidth * imgHeight);
      frames.push({ pixels, delayCs: pendingDelay });
      pendingDelay = 0;
      continue;
    }
    // Unknown marker -- bail rather than loop forever on a malformed file.
    throw new Error(`gif: unexpected block marker 0x${marker.toString(16)} at offset ${offset}`);
  }

  return { width, height, globalColorTable, frames };
}
