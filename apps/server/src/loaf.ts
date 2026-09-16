import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

// LoaF ("Linear Object Archive Format", https://github.com/defcron/loaf) is a
// single-line, self-checksummed archive format: a set of files is tarred,
// gzipped, and hex-encoded, then prefixed with a SHA256 header covering the
// hex text. loaf.sh (the reference CLI) builds this with plain `tar`, `gzip`,
// `xxd`, and `sha256sum`; this module reimplements the same pipeline natively
// so Mirror never has to shell out to those binaries. It hand-rolls a minimal
// USTAR reader/writer (Node has no built-in tar) rather than adding a tar
// dependency, matching the reference implementation's own "nothing fancy,
// just standard tools" philosophy with the closest Node equivalent.
//
// Format, verbatim from the LoaF README:
//   SHA256(-)=<64-hex-hash> <hex-encoded-gzipped-tar-data>
// The hash covers the hex-encoded text (not the raw compressed bytes, and
// not the tar bytes) -- exactly what `sha256sum` would compute over the hex
// string loaf.sh writes to the file.

// A valid .loaf is always exactly one line, no embedded newlines at all --
// that's the whole point of the format ("Linear" in the name), which is why
// this is anchored with $ against a single line rather than [\s\S]*. Some
// `xxd` builds (BSD/macOS) don't honor `-c0` and wrap their hex output across
// multiple lines instead of erroring; a .loaf produced that way is malformed
// per spec and is correctly rejected here, not silently repaired.
// Case-insensitive on both the hash and the hex payload: the reference
// `verify` lowercases the header hash before comparing, and `xxd -r -p`
// (and Node's own hex decoder) accept either case for the payload, so a
// hand-edited or foreign .loaf with uppercase hex should still parse.
const HEADER_PATTERN = /^SHA256\(-\)=([0-9A-Fa-f]{64}) ([0-9A-Fa-f]*)$/;
const BLOCK_SIZE = 512;
const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";
const GNU_LONGNAME_TYPEFLAG = "L";
const GNU_LONGNAME_MARKER = "././@LongLink";

export interface LoafEntry {
  /** Path stored inside the archive, e.g. "meta.json" or "attachments/a.png". */
  name: string;
  /** File contents. Omit (or pass a directory-shaped name ending in "/") for a directory entry. */
  content?: Buffer;
  /** Unix permission bits, defaults to 0o644 for files/symlinks and 0o755 for directories. */
  mode?: number;
  /** Modification time; defaults to now. */
  mtime?: Date;
  /**
   * Target path for a symlink entry. When set, `content` is ignored and the
   * entry is written as a USTAR symlink (typeflag "2"), matching how the
   * reference tool's underlying `tar -p` preserves symlinks verbatim rather
   * than following them.
   */
  linkTarget?: string;
}

export interface LoafExtractedEntry {
  name: string;
  content: Buffer;
  isDirectory: boolean;
  /** True for a symlink entry; `linkTarget` holds what it points at. */
  isSymlink?: boolean;
  linkTarget?: string;
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function writeAscii(buffer: Buffer, offset: number, value: string, width: number): void {
  buffer.write(value, offset, width, "utf8");
}

// One 512-byte USTAR header for a single entry. Long names beyond the
// 100-byte `name` field spill into the 155-byte `prefix` field (real USTAR
// behavior). Names/link targets too long even for that combination are
// preceded by a synthetic GNU longname/longlink ('L'/'K') entry by `tar()`
// below -- this function just writes a best-effort truncated fallback into
// the classic field in that case, since any longname-aware reader (including
// `untar()` here) ignores it in favor of the preceding block.
function buildHeader(entry: { name: string; size: number; mode: number; mtime: Date; typeflag: string; linkname?: string }): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const nameBytes = Buffer.from(entry.name, "utf8");
  if (nameBytes.length > 100) {
    // Standard ustar prefix splitting: split at the LAST "/" (not the
    // earliest one that would fit) so the 155-byte prefix field is used as
    // fully as possible, and only the final path segment has to fit in the
    // 100-byte name field.
    const lastSlash = entry.name.lastIndexOf("/");
    const prefix = lastSlash >= 0 ? entry.name.slice(0, lastSlash) : "";
    const shortName = lastSlash >= 0 ? entry.name.slice(lastSlash + 1) : entry.name;
    if (lastSlash >= 0 && Buffer.byteLength(shortName) <= 100 && Buffer.byteLength(prefix) <= 155) {
      writeAscii(header, 345, prefix, 155);
      writeAscii(header, 0, shortName, 100);
    } else {
      writeAscii(header, 0, entry.name.slice(0, 100), 100);
    }
  } else {
    writeAscii(header, 0, entry.name, 100);
  }
  writeAscii(header, 100, octal(entry.mode, 8), 8);
  writeAscii(header, 108, octal(0, 8), 8); // uid
  writeAscii(header, 116, octal(0, 8), 8); // gid
  writeAscii(header, 124, octal(entry.size, 12), 12);
  writeAscii(header, 136, octal(Math.floor(entry.mtime.getTime() / 1000), 12), 12);
  header.write("        ", 148, 8, "ascii"); // chksum placeholder, spaces
  header.write(entry.typeflag, 156, 1, "ascii");
  if (entry.linkname !== undefined) {
    writeAscii(header, 157, entry.linkname.length > 100 ? entry.linkname.slice(0, 100) : entry.linkname, 100);
  }
  header.write(USTAR_MAGIC, 257, 6, "ascii");
  writeAscii(header, 263, USTAR_VERSION, 2);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeAscii(header, 148, octal(checksum, 8), 8);
  return header;
}

function pad(buffer: Buffer): Buffer {
  const remainder = buffer.length % BLOCK_SIZE;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(BLOCK_SIZE - remainder)]);
}

/** A GNU tar long-name/long-link extension block: a synthetic entry whose
 * *content* (not its own truncated name field) is the real, arbitrarily long
 * name/link-target string that the immediately following real entry uses. */
function buildLongNameBlock(value: string, typeflag: "L" | "K"): Buffer {
  const content = Buffer.concat([Buffer.from(value, "utf8"), Buffer.alloc(1)]);
  const header = buildHeader({ name: GNU_LONGNAME_MARKER, size: content.length, mode: 0o644, mtime: new Date(0), typeflag });
  return Buffer.concat([header, pad(content)]);
}

function tar(entries: LoafEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const isSymlink = entry.linkTarget !== undefined;
    const isDirectory = !isSymlink && (entry.content === undefined || entry.name.endsWith("/"));
    const name = isDirectory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
    // entry.content is guaranteed defined whenever this is a plain file
    // (the only remaining case once isDirectory/isSymlink are ruled out), so
    // this never falls back -- no `?? Buffer.alloc(0)` dead branch to cover.
    const content = isDirectory || isSymlink ? Buffer.alloc(0) : (entry.content as Buffer);
    const typeflag = isSymlink ? "2" : isDirectory ? "5" : "0";

    const lastSlash = name.lastIndexOf("/");
    const prefix = lastSlash >= 0 ? name.slice(0, lastSlash) : "";
    const shortName = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
    const fitsUstarName = Buffer.byteLength(name) <= 100 || (lastSlash >= 0 && Buffer.byteLength(shortName) <= 100 && Buffer.byteLength(prefix) <= 155);
    if (!fitsUstarName) chunks.push(buildLongNameBlock(name, GNU_LONGNAME_TYPEFLAG));
    if (isSymlink && Buffer.byteLength(entry.linkTarget!) > 100) chunks.push(buildLongNameBlock(entry.linkTarget!, "K"));

    chunks.push(
      buildHeader({
        name,
        size: content.length,
        mode: entry.mode ?? (isDirectory ? 0o755 : 0o644),
        mtime: entry.mtime ?? new Date(),
        typeflag,
        linkname: entry.linkTarget,
      }),
    );
    if (!isDirectory && !isSymlink) chunks.push(pad(content));
  }
  // End of archive: two zeroed 512-byte blocks.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function readOctalField(header: Buffer, offset: number, width: number): number {
  const raw = header.toString("ascii", offset, offset + width).replace(/\0.*$/, "").trim();
  return raw === "" ? 0 : parseInt(raw, 8);
}

function untar(buffer: Buffer): LoafExtractedEntry[] {
  const entries: LoafExtractedEntry[] = [];
  let offset = 0;
  // GNU longname/longlink ('L'/'K') entries carry the real name/link-target
  // for the very next real entry in their content, overriding that entry's
  // own (truncated-to-fit) classic name/linkname fields.
  let pendingLongName: string | undefined;
  let pendingLongLink: string | undefined;
  while (offset + BLOCK_SIZE <= buffer.length) {
    const header = buffer.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    const typeflag = header.toString("ascii", 156, 157);
    const size = readOctalField(header, 124, 12);
    offset += BLOCK_SIZE;
    const content = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === GNU_LONGNAME_TYPEFLAG) {
      pendingLongName = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag === "K") {
      pendingLongLink = content.toString("utf8").replace(/\0.*$/, "");
      continue;
    }

    const prefix = header.toString("utf8", 345, 500).replace(/\0.*$/, "");
    const shortName = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const name = pendingLongName ?? (prefix ? `${prefix}/${shortName}` : shortName);
    const isSymlink = typeflag === "2";
    const linkTarget = isSymlink ? pendingLongLink ?? header.toString("utf8", 157, 257).replace(/\0.*$/, "") : undefined;
    pendingLongName = undefined;
    pendingLongLink = undefined;
    entries.push({ name, content: Buffer.from(content), isDirectory: typeflag === "5", isSymlink, linkTarget });
  }
  return entries;
}

/** Bakes a set of entries into a `.loaf` string: `SHA256(-)=<hash> <hex>`. */
export function makeLoaf(entries: LoafEntry[]): string {
  const hex = gzipSync(tar(entries), { level: 9 }).toString("hex");
  const hash = createHash("sha256").update(hex, "ascii").digest("hex");
  return `SHA256(-)=${hash} ${hex}`;
}

export interface LoafVerifyResult {
  ok: boolean;
  expectedHash: string;
  actualHash: string;
}

/** Parses a `.loaf` string's header/payload without decompressing it. */
function parseLoaf(loaf: string): { hash: string; hex: string } {
  // Trimming only strips a single trailing newline left by e.g. `cat`/a text
  // editor -- a valid .loaf has none of its own. Anything left over after
  // that trim must still be exactly one line.
  const trimmed = loaf.trim();
  if (trimmed.includes("\n")) {
    throw new Error("loaf: not a valid .loaf (must be a single line, found embedded newline(s))");
  }
  const match = HEADER_PATTERN.exec(trimmed);
  if (!match) throw new Error("loaf: not a valid .loaf (expected 'SHA256(-)=<hash> <hex>')");
  // The reference `verify` lowercases the header hash before comparing (a
  // hand-edited .loaf could carry an uppercase hash); the hex payload is
  // left as-is since Buffer's own hex decoder already accepts either case.
  return { hash: match[1].toLowerCase(), hex: match[2] };
}

/** Verifies a `.loaf` string's embedded SHA256 against its own payload. */
export function verifyLoaf(loaf: string): LoafVerifyResult {
  const { hash, hex } = parseLoaf(loaf);
  const actualHash = createHash("sha256").update(hex, "ascii").digest("hex");
  return { ok: actualHash === hash, expectedHash: hash, actualHash };
}

/**
 * Extracts a `.loaf` string's entries.
 *
 * Matches the reference CLI's own split: `extract` only checks the header's
 * *format*, never the checksum (that's what the separate `verify` command/
 * {@link verifyLoaf} is for) -- so this does not verify by default either.
 * Pass `verify: true` for the stricter "only extract if the hash matches"
 * behavior some callers may want, which the reference CLI doesn't offer as
 * a single step but is a reasonable, clearly-opt-in addition here.
 */
export function extractLoaf(loaf: string, options: { verify?: boolean } = {}): LoafExtractedEntry[] {
  const { hash, hex } = parseLoaf(loaf);
  if (options.verify) {
    const actual = createHash("sha256").update(hex, "ascii").digest("hex");
    if (actual !== hash) {
      throw new Error(`loaf: checksum mismatch (expected ${hash}, got ${actual})`);
    }
  }
  const gzipped = Buffer.from(hex, "hex");
  return untar(gunzipSync(gzipped));
}
