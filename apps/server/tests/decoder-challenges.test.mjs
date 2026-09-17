import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { registerDecoderChallengeRoutes } from "../dist/decoder-challenges.js";
import { extractLoaf } from "../dist/loaf.js";
import { decodePngSpeak } from "../dist/pngspeak.js";
import { decodeGptgifV4 } from "../dist/gptgif-v4.js";
import { FONT } from "../dist/gptgif.js";
import { readGif } from "../dist/gif89a.js";

// Decode the original GIF by glyph shape, not the reference decoder's
// arbitrary clustering labels / gzip pipeline. These are raw-byte challenges.
function originalGifBytes(artifact) {
  const gif = readGif(artifact);
  let hex = "";
  for (const frame of gif.frames) for (let cell = 0; cell < 4800; cell++) {
    const rows = [];
    for (let y = 0; y < 8; y++) {
      let mask = 0;
      for (let x = 0; x < 8; x++) {
        if (frame.pixels[(Math.floor(cell / 80) * 8 + y) * 640 + cell % 80 * 8 + x]) mask |= 1 << (7 - x);
      }
      rows.push(mask);
    }
    if (rows.every(value => !value)) return Buffer.from(hex, "hex");
    const n = FONT.findIndex(glyph => glyph.every((value, y) => value === rows[y]));
    assert.ok(n >= 0); hex += n.toString(16);
  }
  return Buffer.from(hex, "hex");
}
const decode = { loaf: file => extractLoaf(file.toString())[0].content, pngspeak: decodePngSpeak, gptgif: originalGifBytes, "gptgif-v4": decodeGptgifV4 };
function fixture(t) {
  const app = Fastify(); let scope = "account:0";
  registerDecoderChallengeRoutes(app, () => scope);
  t.after(() => app.close());
  const create = async (body = { format: "loaf" }) => app.inject({ method: "POST", url: "/api/decoder-challenges", payload: body });
  const verify = (id, hex) => app.inject({ method: "POST", url: `/api/decoder-challenges/${id}/verify`, payload: { hex } });
  const artifact = id => app.inject(`/api/decoder-challenges/${id}/artifact`);
  return { app, create, verify, artifact, setScope: value => { scope = value; } };
}

test.describe("server / decoder challenges", () => {
  for (const format of Object.keys(decode)) for (const payload of ["text", "binary"]) {
    test(`${format} ${payload}: prompt transport and original artifact recover exactly`, async t => {
      const f = fixture(t);
      const res = await f.create({ format, payload, guidance: payload === "text" ? "guided" : "independent" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["cache-control"], "no-store");
      const challenge = res.json();
      const extension = { loaf: "loaf", pngspeak: "pngspk.png", gptgif: "gptgif.gif", "gptgif-v4": "gptgif-v4.gif" }[format];
      assert.ok(challenge.filename.endsWith(`.${extension}`));
      assert.deepEqual(Object.keys(challenge).sort(), ["artifactBytes", "expiresAt", "filename", "format", "guidance", "id", "label", "payload", "prompt"].sort());
      const download = await f.artifact(challenge.id);
      assert.equal(download.statusCode, 200);
      assert.match(download.headers["content-disposition"], /attachment/);
      assert.match(download.headers["content-disposition"], new RegExp(`decoder-${challenge.id}\\.${extension}`));
      assert.equal(download.headers["cache-control"], "no-store");
      const encoded = challenge.prompt.split("BEGIN_GZIP_BASE64\n")[1].split("\nEND_GZIP_BASE64")[0];
      const bytes = gunzipSync(Buffer.from(encoded, "base64"));
      assert.deepEqual(bytes, download.rawPayload);
      assert.equal(challenge.artifactBytes, bytes.length);
      const answer = decode[format](bytes);
      if (payload === "text") {
        assert.match(answer.toString(), /café, stars ✨/);
        assert.equal(answer.at(-1), 10);
        assert.ok(challenge.prompt.includes("FORMAT GUIDE"));
        assert.ok(!challenge.prompt.includes(answer.toString()));
      } else {
        assert.equal(answer.length, 128);
        assert.ok(!challenge.prompt.includes("FORMAT GUIDE"));
      }
      assert.ok(challenge.prompt.includes(`MIRROR_ANSWER_${challenge.id}: HEX`));
      const check = await f.verify(challenge.id, answer.toString("hex").toUpperCase());
      assert.equal(check.statusCode, 200);
      assert.equal(check.headers["cache-control"], "no-store");
      assert.deepEqual(check.json(), { verdict: "exact", matchingBytes: answer.length, expectedBytes: answer.length, actualBytes: answer.length });
      const wrong = Buffer.from(answer); wrong[0] ^= 255;
      assert.equal((await f.verify(challenge.id, wrong.toString("hex"))).json().verdict, "partial");
      const extra = Buffer.concat([answer, Buffer.from([0])]);
      assert.equal((await f.verify(challenge.id, extra.toString("hex"))).json().verdict, "partial");
      assert.equal((await f.verify(challenge.id, "")).json().verdict, "mismatch");
      const inverse = Buffer.from(answer.map(value => value ^ 255));
      assert.equal((await f.verify(challenge.id, inverse.toString("hex"))).json().matchingBytes, 0);
    });
  }
  test("validates options, ids, answer syntax and sizes before decoding anything", async t => {
    const f = fixture(t);
    // Minimal fixture error handler matches the production Zod classification.
    f.app.setErrorHandler((e, req, reply) => reply.code(e.name === "ZodError" ? 400 : e.statusCode).send({ error: e.message }));
    for (const body of [{}, { format: "zip" }, { format: "loaf", guidance: "wrong" }, { format: "loaf", payload: "wrong" }, { format: "loaf", path: "/etc/passwd" }]) assert.equal((await f.create(body)).statusCode, 400);
    const { id } = (await f.create()).json();
    for (const hex of ["0", "gg", "00 11", "00".repeat(4097)]) assert.equal((await f.verify(id, hex)).statusCode, 400);
    assert.equal((await f.verify("invalid", "00")).statusCode, 400);
    assert.equal((await f.artifact("invalid")).statusCode, 400);
    assert.equal((await f.verify(id, "00".repeat(6000))).statusCode, 413);
  });
  test("missing, expired, and changed-session challenges are unavailable", async t => {
    const f = fixture(t), missing = "00000000-0000-4000-8000-000000000000";
    for (const read of [f.artifact, id => f.verify(id, "00")]) assert.equal((await read(missing)).statusCode, 404);
    const first = (await f.create()).json();
    f.setScope("account:1");
    for (const read of [f.artifact, id => f.verify(id, "00")]) assert.equal((await read(first.id)).statusCode, 404);
    await f.create(); // removes obsolete session entries
    f.setScope("account:0");
    assert.equal((await f.artifact(first.id)).statusCode, 404);
    const fresh = (await f.create()).json();
    t.mock.method(Date, "now", () => fresh.expiresAt);
    for (const read of [f.artifact, id => f.verify(id, "00")]) assert.equal((await read(fresh.id)).statusCode, 404);
    assert.equal((await f.create()).statusCode, 200); // expired entries are swept
  });
  test("bounds the shelf without silently evicting another open challenge", async t => {
    const f = fixture(t);
    const first = (await f.create()).json();
    for (let i = 1; i < 64; i++) assert.equal((await f.create()).statusCode, 200);
    assert.equal((await f.create()).statusCode, 429);
    assert.equal((await f.artifact(first.id)).statusCode, 200);
  });
  test("downloads an independently readable kit for every format without answer keys", async t => {
    const f = fixture(t), all = [];
    for (const format of Object.keys(decode)) all.push((await f.create({ format, guidance: "independent" })).json());
    const response = await f.app.inject({ method: "POST", url: "/api/decoder-challenges/kit", payload: { ids: all.map(c => c.id) } });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-disposition"], /mirror-decoder-kits.tar.gz/);
    assert.match(response.headers["content-type"], /application\/gzip/);
    const hex = response.rawPayload.toString("hex");
    const entries = extractLoaf(`SHA256(-)=${createHash("sha256").update(hex).digest("hex")} ${hex}`);
    assert.equal(entries.length, 16);
    for (const c of all) {
      const group = entries.filter(e => e.name.startsWith(`${c.format}-${c.id}/`));
      assert.equal(group.length, 4);
      assert.deepEqual(group.find(e => e.name.endsWith(c.filename)).content, (await f.artifact(c.id)).rawPayload);
      assert.equal(group.find(e => e.name.endsWith("/prompt.txt")).content.toString(), c.prompt);
      assert.ok(group.find(e => e.name.endsWith("/format-guide.txt")).content.length > 0);
      assert.match(group.find(e => e.name.endsWith("/README.txt")).content.toString(), /No answer key/);
      assert.ok(!c.prompt.includes("FORMAT GUIDE"));
    }
    const missing = "00000000-0000-4000-8000-000000000000";
    assert.equal((await f.app.inject({ method: "POST", url: "/api/decoder-challenges/kit", payload: { ids: [missing] } })).statusCode, 404);
    f.setScope("different-session");
    assert.equal((await f.app.inject({ method: "POST", url: "/api/decoder-challenges/kit", payload: { ids: [all[0].id] } })).statusCode, 404);
    f.setScope("account:0");
    t.mock.method(Date, "now", () => all[0].expiresAt);
    assert.equal((await f.app.inject({ method: "POST", url: "/api/decoder-challenges/kit", payload: { ids: [all[0].id] } })).statusCode, 404);
  });
});
