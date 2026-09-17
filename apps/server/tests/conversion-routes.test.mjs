import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ZodError } from "zod";
import { registerConversionRoutes, serializeLoafEntry, runGauntletFormat } from "../dist/conversion-routes.js";
import { decodePngSpeak } from "../dist/pngspeak.js";
import { decodeGptgifV4, fontToBytes, defaultPalette, paletteToBytes } from "../dist/gptgif-v4.js";
import { extractLoaf, makeLoaf } from "../dist/loaf.js";

const b64 = (value) => Buffer.from(value).toString("base64");
const firstSeenClusterMap = (hex, alphabetSize) => {
  const seen = [];
  for (const digit of hex) {
    if (!seen.includes(digit)) seen.push(digit);
    if (seen.length === alphabetSize) break;
  }
  return seen.join("");
};
function fixture(t) {
  const app = Fastify({ bodyLimit: 10_000_000 });
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof ZodError ? 400 : Number(error.statusCode ?? 500);
    return reply.code(status).send({ error: error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : status >= 500 ? "Internal server error" : error.message });
  });
  registerConversionRoutes(app);
  t.after(() => app.close());
  return {
    app,
    post: (url, payload, contentType = "application/json") => app.inject({ method: "POST", url, payload, headers: { "content-type": contentType } }),
    get: (url) => app.inject({ method: "GET", url }),
  };
}

test.describe("server / conversion routes", () => {
  test("normalizes legacy LoaF entries and isolates each gauntlet codec failure", () => {
    const legacyEntry = serializeLoafEntry({ name: "old", content: Buffer.from("old"), isDirectory: false });
    assert.equal(legacyEntry.isSymlink, false);
    assert.equal(legacyEntry.contentBase64, b64("old"));
    const passed = runGauntletFormat("loaf", Buffer.from("ok"));
    assert.equal(passed.ok, true);
    assert.ok(passed.artifactBytes > 0);
    assert.deepEqual(runGauntletFormat("loaf", Buffer.from("x"), () => { throw "codec offline"; }), {
      format: "loaf", ok: false, error: "codec offline",
    });
    assert.deepEqual(runGauntletFormat("loaf", Buffer.from("x"), () => { throw new Error("codec error"); }), {
      format: "loaf", ok: false, error: "codec error",
    });
  });

  test("discovers all formats and documents raw I/O options", async (t) => {
    const { get } = fixture(t);
    const response = await get("/api/convert/formats");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().formats.map((f) => f.id), ["loaf", "pngspeak", "gptgif", "gptgif-v4"]);
    assert.deepEqual(response.json().formats.map((f) => f.extension), ["loaf", "pngspk.png", "gptgif.gif", "gptgif-v4.gif"]);
    assert.match(response.json().io.raw_in, /application\/octet-stream/);
  });

  test("LoaF JSON and raw encode/decode/verify preserve files and checksum policy", async (t) => {
    const { post } = fixture(t);
    const encoded = await post("/api/convert/loaf/encode", { entries: [{ name: "nested/a.txt", contentBase64: b64("hello"), mtime: "2020-01-01T00:00:00.000Z" }, { name: "folder/" }, { name: "link", linkTarget: "nested/a.txt" }] });
    assert.equal(encoded.statusCode, 200);
    const loaf = encoded.json().loaf;
    const decoded = await post("/api/convert/loaf/decode", { loaf });
    assert.equal(decoded.json().entries[0].contentBase64, b64("hello"));
    assert.equal(decoded.json().entries[1].isDirectory, true);
    assert.equal(decoded.json().entries[2].linkTarget, "nested/a.txt");
    assert.equal((await post("/api/convert/loaf/verify", { loaf })).json().ok, true);
    const raw = await post("/api/convert/loaf/encode?raw=1&name=raw.txt", Buffer.from("raw bytes"), "application/octet-stream");
    assert.equal(raw.headers["content-type"], "text/plain");
    const rawDecoded = await post("/api/convert/loaf/decode?raw_in=1&verify=1", raw.rawPayload, "text/plain");
    assert.equal(rawDecoded.json().entries[0].contentBase64, b64("raw bytes"));
    assert.equal((await post("/api/convert/loaf/verify?raw_in=1", raw.rawPayload, "text/plain")).json().ok, true);
    const unnamedRaw = await post("/api/convert/loaf/encode?raw_in=1&raw_out=1", Buffer.from("default name"), "application/octet-stream");
    assert.equal(extractLoaf(unnamedRaw.body)[0].name, "payload.bin");
    const datedRaw = await post("/api/convert/loaf/encode?raw_in=1&name=dated.txt&mtime=2020-01-01T00%3A00%3A00.000Z", Buffer.from("dated"), "application/octet-stream");
    assert.equal(datedRaw.statusCode, 200);
    assert.equal(extractLoaf(datedRaw.json().loaf)[0].name, "dated.txt");
    const emptyArchive = makeLoaf([]);
    const emptyDecode = await post("/api/convert/onion/decode", { dataBase64: b64(emptyArchive), chain: ["loaf"] });
    assert.equal(emptyDecode.statusCode, 500);
    assert.equal((await post("/api/convert/loaf/decode?raw_in=1", Buffer.from("nope"), "text/plain")).statusCode, 400);
    assert.equal((await post("/api/convert/loaf/encode?raw_in=1", { data: "not bytes" })).statusCode, 400);
  });

  test("PngSpeak supports JSON and raw transports, dimensions and binary recovery", async (t) => {
    const { post } = fixture(t);
    const source = Buffer.from([1, 2, 3, 4, 5]);
    const encoded = await post("/api/convert/pngspeak/encode", { dataBase64: source.toString("base64") });
    assert.equal(encoded.statusCode, 200);
    const decoded = await post("/api/convert/pngspeak/decode", { dataBase64: encoded.json().dataBase64, length: source.length });
    assert.deepEqual(Buffer.from(decoded.json().dataBase64, "base64"), source);
    const raw = await post("/api/convert/pngspeak/encode?raw=1", source, "application/octet-stream");
    const recovered = await post("/api/convert/pngspeak/decode?raw_in=1", raw.rawPayload, "image/png");
    assert.deepEqual(decodePngSpeak(raw.rawPayload), source);
    assert.deepEqual(Buffer.from(recovered.json().dataBase64, "base64"), source);
    const scaled = await post("/api/convert/pngspeak/encode", { dataBase64: source.toString("base64"), width: 3, height: 2, upscaleWidth: 12, upscaleHeight: 8 });
    assert.equal(scaled.statusCode, 200);
    assert.equal((await post("/api/convert/pngspeak/encode?raw_in=1&raw_out=1&width=2&height=1", Buffer.from([0]), "application/octet-stream")).statusCode, 200);
  });

  test("original gptgif encode, calibration and mapped decode work in JSON and raw modes", async (t) => {
    const { post } = fixture(t);
    const source = Buffer.from("0123456789abcdef 0123456789abcdef");
    const encoded = await post("/api/convert/gptgif/encode", { parts: [b64(source.subarray(0, 18)), b64(source.subarray(18))] });
    const artifact = Buffer.from(encoded.json().dataBase64, "base64");
    const clusterMap = firstSeenClusterMap(source.toString("hex"), 16);
    const calibrated = await post("/api/convert/gptgif/calibrate", { dataBase64: artifact.toString("base64"), clusterMap });
    assert.match(calibrated.json().clusterMap, /Cluster Label/);
    const decoded = await post("/api/convert/gptgif/decode", { dataBase64: artifact.toString("base64"), clusterMap });
    assert.deepEqual(Buffer.from(decoded.json().dataBase64, "base64"), source);
    const rawEncoded = await post("/api/convert/gptgif/encode?raw_in=1&raw_out=1", source, "application/octet-stream");
    assert.equal(rawEncoded.headers["content-type"], "image/gif");
    const rawMap = await post(`/api/convert/gptgif/calibrate?raw_in=1&clusterMap=${clusterMap}`, rawEncoded.rawPayload, "image/gif");
    assert.match(rawMap.json().clusterMap, /Cluster Label/);
    const rawDecoded = await post(`/api/convert/gptgif/decode?raw_in=1&clusterMap=${clusterMap}`, rawEncoded.rawPayload, "image/gif");
    assert.deepEqual(Buffer.from(rawDecoded.json().dataBase64, "base64"), source);
  });

  test("gptgif-v4 style endpoints serialize reusable styles and validate custom inputs", async (t) => {
    const { get, post } = fixture(t);
    const random = await get("/api/convert/gptgif-v4/random-style?fontSeed=2&paletteSeed=3");
    const randomStyle = random.json();
    assert.equal(Buffer.from(randomStyle.fontBase64, "base64").length, 128);
    assert.equal(Buffer.from(randomStyle.paletteBase64, "base64").length, 768);
    const unseeded = (await get("/api/convert/gptgif-v4/random-style")).json();
    assert.ok(Number.isInteger(unseeded.fontSeed));
    assert.ok(Number.isInteger(unseeded.paletteSeed));
    const defaults = (await get("/api/convert/gptgif-v4/default-style")).json();
    assert.equal(defaults.palette.length, 256);
    assert.equal((await post("/api/convert/gptgif-v4/font/validate", { fontBase64: fontToBytes(randomStyle.font).toString("base64") })).json().valid, true);
    assert.equal((await post("/api/convert/gptgif-v4/palette/validate", { paletteBase64: paletteToBytes(defaultPalette()).toString("base64") })).json().valid, true);
    const invalidFont = Buffer.alloc(128).toString("base64");
    assert.equal((await post("/api/convert/gptgif-v4/font/validate", { fontBase64: invalidFont })).json().valid, false);
    assert.equal((await post("/api/convert/gptgif-v4/palette/validate", { paletteBase64: Buffer.alloc(768).toString("base64") })).json().valid, false);
    const payload = Buffer.from("v4 style input");
    const encoded = await post("/api/convert/gptgif-v4/encode", { dataBase64: payload.toString("base64"), fontSeed: 7, paletteSeed: 8 });
    assert.deepEqual(decodeGptgifV4(Buffer.from(encoded.json().dataBase64, "base64")), payload);
    const customStyle = await post("/api/convert/gptgif-v4/encode", { dataBase64: payload.toString("base64"), fontBase64: randomStyle.fontBase64, paletteBase64: randomStyle.paletteBase64 });
    assert.equal(customStyle.statusCode, 200, customStyle.body);
    const customBytes = Buffer.from(customStyle.json().dataBase64, "base64");
    const decoded = await post("/api/convert/gptgif-v4/decode", { dataBase64: customBytes.toString("base64") });
    assert.equal(decoded.statusCode, 200, decoded.body);
    assert.deepEqual(Buffer.from(decoded.json().dataBase64, "base64"), payload);
    const rawCustom = await post("/api/convert/gptgif-v4/encode?raw=1&fontSeed=7&paletteSeed=8", payload, "application/octet-stream");
    assert.equal(rawCustom.statusCode, 200, rawCustom.body);
    const rawDecoded = await post("/api/convert/gptgif-v4/decode?raw_in=1", rawCustom.rawPayload, "image/gif");
    assert.deepEqual(Buffer.from(rawDecoded.json().dataBase64, "base64"), payload);
    assert.equal((await post("/api/convert/gptgif-v4/encode", { dataBase64: b64("x"), fontSeed: 1, fontBase64: randomStyle.fontBase64 })).statusCode, 400);
    assert.equal((await post("/api/convert/gptgif-v4/encode", { dataBase64: b64("x"), fontBase64: b64("bad") })).statusCode, 400);
    assert.equal((await post("/api/convert/gptgif-v4/encode", { dataBase64: b64("x"), paletteSeed: 1, paletteBase64: randomStyle.paletteBase64 })).statusCode, 400);
    assert.equal((await post("/api/convert/gptgif-v4/encode", { dataBase64: b64("unseeded defaults") })).statusCode, 200);
  });

  test("v4 font preview is readable and GIF89a encodes/inspects structured and raw GIFs", async (t) => {
    const { get, post } = fixture(t);
    const preview = await get("/api/convert/gptgif/font-preview");
    assert.match(preview.body, /Glyph 0:/);
    const colors = [{ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }];
    const encoded = await post("/api/convert/gif89a/encode", { width: 2, height: 1, colors, frames: [{ pixels: [0, 1], delayCs: 4 }] });
    const inspected = await post("/api/convert/gif89a/inspect", { dataBase64: encoded.json().dataBase64 });
    assert.deepEqual({ width: inspected.json().width, height: inspected.json().height, frameCount: inspected.json().frameCount }, { width: 2, height: 1, frameCount: 1 });
    const raw = await post("/api/convert/gif89a/encode?raw=1&width=2&height=1&colors=000000,ffffff&delayCs=5", Buffer.from([0, 1]), "application/octet-stream");
    const rawInspect = await post("/api/convert/gif89a/inspect?raw_in=1", raw.rawPayload, "image/gif");
    assert.equal(rawInspect.json().frames[0].delayCs, 5);
    assert.match(raw.headers["content-disposition"], /mirror\.gif/);
    assert.equal((await post("/api/convert/gif89a/encode", { width: 2, height: 1, colors, frames: [{ pixels: [0] }] })).statusCode, 400);
    assert.equal((await post("/api/convert/gif89a/encode", { width: 1, height: 1, colors, frames: [{ pixels: [2] }] })).statusCode, 400);
    assert.equal((await post("/api/convert/gif89a/encode?raw_in=1&width=2&height=1", Buffer.from([0]), "application/octet-stream")).statusCode, 400);
    assert.equal((await post("/api/convert/gif89a/encode?raw_in=1&width=1&height=1&colors=000000", Buffer.from([2]), "application/octet-stream")).statusCode, 400);
  });

  test("roundtrip, onion, prompt, mystery, fortune and gauntlet endpoints compose formats", async (t) => {
    const { get, post } = fixture(t);
    const source = Buffer.from("tiny payload");
    for (const format of ["loaf", "pngspeak", "gptgif-v4"]) {
      const rt = await post("/api/convert/roundtrip", { format, dataBase64: source.toString("base64") });
      assert.equal(rt.json().ok, true, format);
    }
    const rawRoundtrip = await post("/api/convert/roundtrip?raw_in=1&format=pngspeak", source, "application/octet-stream");
    assert.equal(rawRoundtrip.json().ok, true);
    const onion = await post("/api/convert/onion/encode", { dataBase64: source.toString("base64"), chain: ["loaf", "pngspeak"] });
    const onionDecode = await post("/api/convert/onion/decode", { dataBase64: onion.json().dataBase64, chain: ["loaf", "pngspeak"] });
    assert.deepEqual(Buffer.from(onionDecode.json().dataBase64, "base64"), source);
    const rawOnion = await post("/api/convert/onion/encode?raw=1&chain=%20loaf%20,%20pngspeak%20", source, "application/octet-stream");
    const rawOnionDecode = await post("/api/convert/onion/decode?raw=1&chain=loaf,pngspeak", rawOnion.rawPayload, "image/png");
    assert.deepEqual(Buffer.from(rawOnionDecode.json().dataBase64, "base64"), source);
    assert.equal((await post("/api/convert/onion/encode?raw_in=1&chain=loaf,unknown", source, "application/octet-stream")).statusCode, 400);
    const prompt = await post("/api/convert/gpt-prompt", { dataBase64: b64("secret"), format: "loaf", filename: "spaces and !.txt", note: "decode please" });
    assert.match(prompt.json().prompt, /spaces_and__.txt/);
    assert.match(prompt.json().prompt, /Note from the sender: decode please/);
    const rawPrompt = await post("/api/convert/gpt-prompt?raw_in=1&format=pngspeak", Buffer.from("raw prompt"), "application/octet-stream");
    assert.equal(rawPrompt.json().format, "pngspeak");
    assert.match(rawPrompt.json().prompt, /decoded\.pngspk\.png/);
    const emptyFilenamePrompt = await post("/api/convert/gpt-prompt", { dataBase64: b64("x"), format: "loaf", filename: "" });
    assert.equal(emptyFilenamePrompt.json().filename, "payload.bin");
    const mystery = await get("/api/convert/mystery?text=hello");
    assert.ok(["loaf", "pngspeak", "gptgif", "gptgif-v4"].includes(mystery.json().format));
    const randomMystery = await get("/api/convert/mystery");
    assert.ok(randomMystery.json().bytes > 0);
    const fortune = await get("/api/convert/fortune?format=loaf");
    assert.match(fortune.headers["content-disposition"], /fortune\.loaf/);
    const gifFortune = await get("/api/convert/fortune?format=gptgif-v4");
    assert.match(gifFortune.headers["content-disposition"], /fortune\.gptgif-v4\.gif/);
    assert.equal((await post("/api/convert/gauntlet", { dataBase64: b64("gauntlet") })).json().results.length, 4);
    const rawGauntlet = await post("/api/convert/gauntlet?raw_in=1", source, "application/octet-stream");
    assert.equal(rawGauntlet.json().results.length, 4);
  });

  test("defensive error formatters accept thrown values whose Error identity is unavailable", async (t) => {
    const { post } = fixture(t);
    const previous = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
    Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, value: () => false });
    try {
      const loafDecode = await post("/api/convert/loaf/decode", { loaf: "not an archive" });
      assert.equal(loafDecode.statusCode, 400);
      assert.match(loafDecode.json().error, /archive|LoaF|gzip/i);
      const font = await post("/api/convert/gptgif-v4/font/validate", { fontBase64: b64("short") });
      assert.equal(font.json().valid, false);
      assert.match(font.json().error, /font/i);
      const palette = await post("/api/convert/gptgif-v4/palette/validate", { paletteBase64: b64("short") });
      assert.equal(palette.json().valid, false);
      assert.match(palette.json().error, /palette/i);
      const encode = await post("/api/convert/gptgif-v4/encode", { dataBase64: b64("x"), fontBase64: b64("short") });
      assert.equal(encode.statusCode, 400);
      assert.match(encode.json().error, /font/i);
      const gauntlet = await post("/api/convert/gauntlet", { dataBase64: b64("x") });
      assert.equal(gauntlet.statusCode, 200);
    } finally {
      if (previous) Object.defineProperty(Error, Symbol.hasInstance, previous);
      else delete Error[Symbol.hasInstance];
    }
  });
});
