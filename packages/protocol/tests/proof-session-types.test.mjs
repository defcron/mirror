import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProofConfig,
  generateProofToken,
  generateProofTokenAsync,
  generateProofTokenInWorker,
  mintAccessToken,
  SessionTokenInvalidError,
  BackendApiError,
  normalizeGizmos,
} from "../dist/index.js";

test("explicit proof configurations are copied, including their attempt counter", async () => {
  const config = [1, "date", null, 99, null, "url", "deploy", "en", "en-US", null, "plugins", "react", "event"];
  for (const generate of [generateProofToken, generateProofTokenAsync]) {
    const token = await generate({ required: true, seed: "fixture", difficulty: "f", proofConfig: config });
    const decoded = decodeProofConfig(token);
    assert.equal(decoded[3], 0);
    assert.equal(config[3], 99);
    assert.deepEqual(decoded.slice(4), config.slice(4));
  }
});

test("worker success and failure detach the supplied abort signal", async () => {
  const signal = new AbortController().signal;
  assert.match(await generateProofTokenInWorker({ required: true, seed: "fixture", difficulty: "f" }, signal), /^gAAAAAB/);
  await assert.rejects(generateProofTokenInWorker({ required: true }, signal), /Invalid required/);
});

test("session minting handles invalid JWT payloads and legacy headers without cookies", async (t) => {
  for (const payload of ["invalid-json", JSON.stringify({}), JSON.stringify({ exp: "123" })]) {
    const token = `header.${Buffer.from(payload).toString("base64url")}.sig`;
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ accessToken: token }), headers: { get: () => null } }));
    const before = Date.now();
    const result = await mintAccessToken("synthetic-session");
    assert.equal(result.accessToken, token);
    assert.ok(result.expiresAt >= before + 600_000);
    assert.equal(result.rotatedSessionToken, null);
  }
});

// --- proof.ts: decodeProofConfig -------------------------------------------------

test("decodeProofConfig recognizes absent or unmarked hints", () => {
  assert.equal(decodeProofConfig(null), null);
  assert.equal(decodeProofConfig(undefined), null);
  assert.equal(decodeProofConfig("no marker here"), null);
});

test("decodeProofConfig round-trips a real embedded config and rejects malformed ones", () => {
  const original = [1, "b", null, 0, "ua", "c", "d", "en", "en-US", null, "e", "f", "g"];
  const encoded = Buffer.from(JSON.stringify(original), "utf-8").toString("base64");
  assert.deepEqual(decodeProofConfig(`gAAAAAB${encoded}~rest`), original);
  // Marker present but nothing after it.
  assert.equal(decodeProofConfig("gAAAAAB"), null);
  // Marker present, but the payload doesn't decode to valid base64 JSON.
  assert.equal(decodeProofConfig("gAAAAAB!!!not-base64!!!~x"), null);
  // Valid base64/JSON, but not an array.
  const notArray = Buffer.from(JSON.stringify({ a: 1 }), "utf-8").toString("base64");
  assert.equal(decodeProofConfig(`gAAAAAB${notArray}~x`), null);
});

// --- proof.ts: generateProofToken (sync) ------------------------------------------

test("generateProofToken returns null when not required", () => {
  assert.equal(generateProofToken({ required: false }), null);
});

test("generateProofToken rejects an incomplete challenge", () => {
  assert.throws(
    () => generateProofToken({ required: true, seed: "", difficulty: "" }),
    /Invalid required proof-of-work challenge/,
  );
  assert.throws(
    () => generateProofToken({ required: true, seed: "s", difficulty: "not-hex" }),
    /Invalid required proof-of-work challenge/,
  );
});

test("generateProofToken finds a real solution for an easy difficulty", () => {
  const token = generateProofToken({ required: true, seed: "seed", difficulty: "f", maxAttempts: 100_000 });
  assert.match(token, /^gAAAAAB/);
  assert.equal(token.startsWith("gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"), false);
});

test("generateProofToken falls back to the reference token once attempts are exhausted", () => {
  const token = generateProofToken({ required: true, seed: "seed", difficulty: "0000000", maxAttempts: 1 });
  assert.equal(token, "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + Buffer.from('"seed"', "utf-8").toString("base64"));
});

// --- proof.ts: generateProofTokenAsync --------------------------------------------

test("generateProofTokenAsync returns null when not required", async () => {
  assert.equal(await generateProofTokenAsync({ required: false }), null);
});

test("generateProofTokenAsync rejects an incomplete challenge", async () => {
  await assert.rejects(
    generateProofTokenAsync({ required: true, seed: "", difficulty: "" }),
    /Invalid required proof-of-work challenge/,
  );
});

test("generateProofTokenAsync finds a real solution for an easy difficulty", async () => {
  const token = await generateProofTokenAsync({ required: true, seed: "seed", difficulty: "f", maxAttempts: 100_000 });
  assert.match(token, /^gAAAAAB/);
});

test("generateProofTokenAsync yields cooperatively and still falls back when exhausted", async () => {
  const token = await generateProofTokenAsync({
    required: true,
    seed: "seed",
    difficulty: "0000000",
    maxAttempts: 2500,
    yieldEvery: 500,
  });
  assert.equal(token, "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + Buffer.from('"seed"', "utf-8").toString("base64"));
});

// --- proof.ts: generateProofTokenInWorker (abort path) ----------------------------

test("generateProofTokenInWorker rejects immediately when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateProofTokenInWorker({ required: true, seed: "seed", difficulty: "f" }, controller.signal),
    /AbortError|aborted/,
  );
});

test("generateProofTokenInWorker returns null immediately when not required", async () => {
  assert.equal(await generateProofTokenInWorker({ required: false }), null);
});

// --- session.ts: mintAccessToken ---------------------------------------------------

test("mintAccessToken throws SessionTokenInvalidError on a non-ok response", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 401 });
  try {
    await assert.rejects(mintAccessToken("token"), SessionTokenInvalidError);
  } finally {
    globalThis.fetch = original;
  }
});

test("mintAccessToken throws SessionTokenInvalidError when the body has no accessToken", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ notAccessToken: true });
  try {
    await assert.rejects(mintAccessToken("token"), SessionTokenInvalidError);
  } finally {
    globalThis.fetch = original;
  }
});

test("mintAccessToken falls back to a 10-minute expiry when the accessToken has no parseable exp claim", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ accessToken: "not-a-real-jwt" });
  const before = Date.now();
  try {
    const minted = await mintAccessToken("token");
    assert.equal(minted.accessToken, "not-a-real-jwt");
    assert.ok(minted.expiresAt >= before + 9 * 60 * 1000);
    assert.ok(minted.expiresAt <= before + 11 * 60 * 1000);
    assert.equal(minted.rotatedSessionToken, null);
  } finally {
    globalThis.fetch = original;
  }
});

test("mintAccessToken falls back to a single set-cookie header on runtimes without getSetCookie", async () => {
  const original = globalThis.fetch;
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), "utf-8").toString(
    "base64url",
  );
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { accessToken: `header.${payload}.sig` };
    },
    headers: {
      get(name) {
        return name === "set-cookie" ? "__Secure-next-auth.session-token=rotated-fallback; Path=/" : null;
      },
      // Deliberately no getSetCookie() - exercises the fallback branch.
    },
  });
  try {
    const minted = await mintAccessToken("token");
    assert.equal(minted.rotatedSessionToken, "rotated-fallback");
  } finally {
    globalThis.fetch = original;
  }
});

test("mintAccessToken reports no rotated token when no set-cookie header names the session cookie", async () => {
  const original = globalThis.fetch;
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }), "utf-8").toString(
    "base64url",
  );
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ accessToken: `header.${payload}.sig` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const minted = await mintAccessToken("token");
    assert.equal(minted.rotatedSessionToken, null);
  } finally {
    globalThis.fetch = original;
  }
});

// --- types.ts: BackendApiError -----------------------------------------------------

test("BackendApiError carries status and body and names itself correctly", () => {
  const error = new BackendApiError("boom", 418, { detail: "teapot" });
  assert.equal(error.name, "BackendApiError");
  assert.equal(error.message, "boom");
  assert.equal(error.status, 418);
  assert.deepEqual(error.body, { detail: "teapot" });
  assert.ok(error instanceof Error);
});

// --- models.ts: normalizeGizmos non-nested candidate branch ------------------------

test("normalizeGizmos recognizes a flat gizmo-shaped record without a nested gizmo.gizmo wrapper", () => {
  const gizmos = normalizeGizmos({
    items: [
      {
        id: "flat-1",
        display_name: "Flat GPT",
        short_url: "flat-gpt",
        author: { name: "Someone" },
      },
    ],
  });
  assert.deepEqual(
    gizmos.map((g) => ({ id: g.id, name: g.name, shortUrl: g.shortUrl })),
    [{ id: "flat-1", name: "Flat GPT", shortUrl: "flat-gpt" }],
  );
});
