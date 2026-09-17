import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractLoaf, makeLoaf, verifyLoaf } from "../dist/loaf.js";

test.describe("server / loaf", () => {

test("long symlink targets use a GNU longlink record and round-trip", () => {
  const target = `target/${"x".repeat(140)}`;
  const entries = extractLoaf(makeLoaf([{ name: "link", linkTarget: target }]));
  assert.equal(entries[0].name, "link");
  assert.equal(entries[0].isSymlink, true);
  assert.equal(entries[0].linkTarget, target);
});

test("bakes a single file and round-trips it", () => {
  const loaf = makeLoaf([{ name: "hello.txt", content: Buffer.from("hi there\n") }]);
  assert.match(loaf, /^SHA256\(-\)=[0-9a-f]{64} [0-9a-f]+$/);
  assert.equal(verifyLoaf(loaf).ok, true);
  const entries = extractLoaf(loaf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "hello.txt");
  assert.equal(entries[0].isDirectory, false);
  assert.equal(entries[0].content.toString(), "hi there\n");
});

test("bakes multiple files under a nested directory", () => {
  const loaf = makeLoaf([
    { name: "meta.json", content: Buffer.from(JSON.stringify({ ok: true })) },
    { name: "attachments/a.png", content: Buffer.from([1, 2, 3, 4]) },
  ]);
  const entries = extractLoaf(loaf);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.equal(byName["meta.json"].content.toString(), '{"ok":true}');
  assert.deepEqual([...byName["attachments/a.png"].content], [1, 2, 3, 4]);
});

test("an explicit directory entry (no content) round-trips as a directory", () => {
  const loaf = makeLoaf([{ name: "empty-dir" }, { name: "trailing-slash-dir/" }]);
  const entries = extractLoaf(loaf);
  assert.equal(entries.find((e) => e.name === "empty-dir/").isDirectory, true);
  assert.equal(entries.find((e) => e.name === "trailing-slash-dir/").isDirectory, true);
});

test("an empty entry list produces a valid, empty archive", () => {
  const loaf = makeLoaf([]);
  assert.equal(verifyLoaf(loaf).ok, true);
  assert.deepEqual(extractLoaf(loaf), []);
});

test("content length exactly on a 512-byte boundary needs no padding", () => {
  const loaf = makeLoaf([{ name: "block.bin", content: Buffer.alloc(512, 7) }]);
  const entries = extractLoaf(loaf);
  assert.equal(entries[0].content.length, 512);
  assert.equal(entries[0].content[0], 7);
});

test("a custom mode and mtime are honored rather than defaulted", () => {
  const mtime = new Date("2020-01-01T00:00:00Z");
  const loaf = makeLoaf([{ name: "script.sh", content: Buffer.from("#!/bin/sh\n"), mode: 0o755, mtime }]);
  assert.equal(verifyLoaf(loaf).ok, true);
  const entries = extractLoaf(loaf);
  assert.equal(entries[0].content.toString(), "#!/bin/sh\n");
});

test("a name requiring the ustar prefix field round-trips correctly", () => {
  const name = `${"a".repeat(150)}/file.txt`; // > 100 bytes total, needs prefix split
  const loaf = makeLoaf([{ name, content: Buffer.from("deep\n") }]);
  const entries = extractLoaf(loaf);
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].content.toString(), "deep\n");
});

test("a filename segment too long for the 100-byte name field uses a GNU longname and round-trips", () => {
  const name = `dir/${"z".repeat(150)}`;
  const entries = extractLoaf(makeLoaf([{ name, content: Buffer.from("x") }]));
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].content.toString(), "x");
});

test("a name with no slash at all, too long for the plain name field, uses a GNU longname and round-trips", () => {
  const name = "n".repeat(150);
  const entries = extractLoaf(makeLoaf([{ name, content: Buffer.from("x") }]));
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].content.toString(), "x");
});

test("a prefix segment too long for the 155-byte prefix field uses a GNU longname and round-trips", () => {
  const name = `${"p".repeat(200)}/file.txt`;
  const entries = extractLoaf(makeLoaf([{ name, content: Buffer.from("x") }]));
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].content.toString(), "x");
});

test("verifyLoaf reports a mismatch without throwing", () => {
  const loaf = makeLoaf([{ name: "a.txt", content: Buffer.from("a") }]);
  const tampered = loaf.replace(/ [0-9a-f]+$/, (hex) => " " + "0".repeat(hex.trim().length));
  const result = verifyLoaf(tampered);
  assert.equal(result.ok, false);
  assert.notEqual(result.actualHash, result.expectedHash);
});

// Tampers only the embedded SHA256 header, leaving the actual payload bytes
// (and thus decompression) untouched -- this is what "checksum says tampered
// but the data itself is still perfectly readable" looks like in practice,
// e.g. a hand-edited or bit-flipped header on an otherwise-intact archive.
function tamperHash(loaf) {
  const [header, hex] = loaf.split(" ");
  const hash = header.slice("SHA256(-)=".length);
  const flipped = hash.at(-1) === "0" ? "1" : "0";
  return `SHA256(-)=${hash.slice(0, -1)}${flipped} ${hex}`;
}

test("extractLoaf allows reference-compatible extraction unless explicit verification is requested", () => {
  const loaf = makeLoaf([{ name: "a.txt", content: Buffer.from("a") }]);
  assert.equal(extractLoaf(tamperHash(loaf))[0].content.toString(), "a");
  assert.throws(() => extractLoaf(tamperHash(loaf), { verify: true }), /checksum mismatch/);
});

test("extractLoaf reads an archive whose header hash was tampered with when verification is omitted", () => {
  const loaf = makeLoaf([{ name: "a.txt", content: Buffer.from("a") }]);
  const entries = extractLoaf(tamperHash(loaf));
  assert.equal(entries[0].content.toString(), "a");
});

test("rejects a string that isn't a .loaf at all", () => {
  assert.throws(() => verifyLoaf("not a loaf"), /not a valid \.loaf/);
});

test("rejects a .loaf with embedded newlines (e.g. from a wrapping hex encoder)", () => {
  const loaf = makeLoaf([{ name: "a.txt", content: Buffer.from("a") }]);
  const [header, hex] = loaf.split(" ");
  const wrapped = `${header} ${hex.slice(0, hex.length / 2)}\n${hex.slice(hex.length / 2)}`;
  assert.throws(() => verifyLoaf(wrapped), /single line/);
  assert.throws(() => extractLoaf(wrapped), /single line/);
});

test("tolerates a single trailing newline the way a text editor or `cat` would leave one", () => {
  const loaf = makeLoaf([{ name: "a.txt", content: Buffer.from("a") }]);
  assert.equal(verifyLoaf(loaf + "\n").ok, true);
});

test("gracefully treats a header field with no digits (blank/corrupt) as size 0", () => {
  // Hand-build a single-entry tar with a blank (space-filled) size field --
  // something our own writer never produces, but a foreign or corrupted
  // archive with a valid checksum could still contain. readOctalField must
  // not crash on it.
  const header = Buffer.alloc(512);
  header.write("blank-size.txt", 0, 100, "utf8");
  header.write(octalField(0o644, 8), 100, 8, "ascii");
  header.write(octalField(0, 8), 108, 8, "ascii");
  header.write(octalField(0, 8), 116, 8, "ascii");
  header.write("            \0", 124, 12, "ascii"); // blank size field
  header.write(octalField(0, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const archive = Buffer.concat([header, Buffer.alloc(512 * 2)]);
  const hex = gzipSync(archive, { level: 9 }).toString("hex");
  const hash = createHash("sha256").update(hex, "ascii").digest("hex");
  const loaf = `SHA256(-)=${hash} ${hex}`;
  const entries = extractLoaf(loaf);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "blank-size.txt");
  assert.equal(entries[0].content.length, 0);

  function octalField(value, width) {
    return value.toString(8).padStart(width - 1, "0") + "\0";
  }
});

test("interoperates with the reference loaf.sh CLI when it's available", () => {
  let loafShPath;
  try {
    loafShPath = execFileSync("bash", ["-lc", "command -v loaf.sh || true"]).toString().trim();
  } catch {
    loafShPath = "";
  }
  if (!loafShPath) {
    // loaf.sh isn't on PATH in every environment (e.g. CI); this test only
    // adds value where the reference implementation is actually reachable.
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "mirror-loaf-"));
  try {
    const loaf = makeLoaf([{ name: "hello.txt", content: Buffer.from("hi\n") }]);
    const loafFile = path.join(dir, "made-by-ts.loaf");
    writeFileSync(loafFile, loaf);
    execFileSync(loafShPath, ["verify", loafFile]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

});
