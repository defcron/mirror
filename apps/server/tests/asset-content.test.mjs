import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "mirror-asset-content-"));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = "synthetic-mirror-key";
delete process.env.MIRROR_STORE_KEY;
const { buildApp } = await import("../dist/index.js");
const store = await import("../dist/store.js");
const { createAssetLinks } = await import("../dist/asset-content.js");
const { ChatGptBackendClient } = await import("@mirror/protocol");
const app = await buildApp();
const fetchBefore = globalThis.fetch;
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const pointer = "sediment://file-image";
const session = () => {
  store.saveVerifiedSession("synthetic-session", "asset-account", "synthetic-device");
  store.updateMintedToken("synthetic-upstream-access", Date.now() + 3600000, null);
};
session();
const ticket = () => store.sealAssetTicket({ pointer, conversationId: "upstream", messageId: "answer", fileName: "résumé [final].png" });
const request = (value = ticket(), extra = "", method = "GET") => app.inject({ method, url: `/api/asset-content?ticket=${encodeURIComponent(value)}${extra}`, headers: { host: "127.0.0.1", origin: "https://www.google.com" } });
test.describe("server / asset-content", () => {
test.after(async () => { globalThis.fetch = fetchBefore; await app.close(); rmSync(dir, { recursive: true, force: true }); });

test("Google image and download requests get real bytes without a browser bearer/cookie", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url)); calls.push({ u, init });
    if (u.pathname.includes("/files/download/")) return Response.json({ download_url: "https://chatgpt.com/backend-api/estuary/content?id=synthetic", file_name: "folder/résumé [final].png", mime_type: "image/png" });
    assert.equal(u.pathname, "/backend-api/estuary/content");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-upstream-access");
    return new Response(bytes, { headers: { "content-type": "image/png", "set-cookie": "must-not-leak=1" } });
  };
  const client = new ChatGptBackendClient({ accessToken: "synthetic-upstream-access", deviceId: "synthetic-device" });
  const links = await createAssetLinks(client, "http://127.0.0.1", pointer, "upstream", "answer");
  assert.equal(links.fileName, "résumé [final].png");
  assert.doesNotMatch(JSON.stringify(links), /synthetic-upstream-access|synthetic-mirror-key|estuary/);
  assert.equal(links.url, `data:image/png;base64,${bytes.toString("base64")}`);
  const res = await request(new URL(links.downloadUrl).searchParams.get("ticket"));
  assert.equal(res.statusCode, 200); assert.deepEqual(res.rawPayload, bytes);
  assert.match(res.headers["content-disposition"], /^inline;/);
  assert.match(res.headers["content-disposition"], /filename\*=UTF-8''r%C3%A9sum%C3%A9%20%5Bfinal%5D.png/);
  assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["set-cookie"], undefined);
  const download = await request(ticket(), "&download=1");
  assert.equal(download.statusCode, 200); assert.deepEqual(download.rawPayload, bytes);
  assert.match(download.headers["content-disposition"], /^attachment;/);
  const head = await request(ticket(), "", "HEAD"); assert.equal(head.statusCode, 200); assert.equal(head.rawPayload.length, 0);
  assert.equal(calls.filter(c => c.u.pathname.includes("/files/download/")).length, 4, "refresh metadata on each access");
});

test("invalid, modified, expired and disconnected-account tickets never reach upstream", async () => {
  globalThis.fetch = async () => assert.fail("Invalid capability reached upstream");
  for (const token of ["invalid", ticket().slice(0, -3) + "bad", store.sealAssetTicket({ pointer, conversationId: "upstream", messageId: "answer", fileName: "test.png" }, Date.now() - 8 * 86400000)]) {
    assert.equal((await request(token)).statusCode, 404);
  }
  const old = ticket(); store.clearSession(); assert.equal((await request(old)).statusCode, 404);
  store.saveVerifiedSession("another-synthetic-session", "other-account", "other-device");
  assert.equal((await request(old)).statusCode, 404); session();
  const badHost = await app.inject({ url: `/api/asset-content?ticket=${ticket()}`, headers: { host: "attacker.test" } });
  assert.equal(badHost.statusCode, 421);
  const control = await app.inject({ url: "/api/session", headers: { origin: "https://www.google.com" } });
  assert.equal(control.statusCode, 403);
});

test("HTML is attachment-only and upstream failure is a safe error", async () => {
  let failed = false;
  globalThis.fetch = async url => String(url).includes("/files/download/")
    ? Response.json({ download_url: "https://chatgpt.com/backend-api/estuary/content?id=synthetic" })
    : new Response(failed ? "private error detail" : "<html>test</html>", { status: failed ? 403 : 200, headers: { "content-type": "text/html" } });
  const html = await request(); assert.equal(html.statusCode, 200); assert.match(html.headers["content-disposition"], /^attachment;/);
  assert.match(html.headers["content-security-policy"], /sandbox/);
  failed = true; const res = await request(); assert.equal(res.statusCode, 502); assert.doesNotMatch(res.body, /private error detail/);
});

test("upstream credentials stay on the exact Estuary endpoint across redirects", async () => {
  const client = new ChatGptBackendClient({ accessToken: "synthetic-secret", deviceId: "synthetic-device" });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    return String(url).includes("chatgpt.com") ? new Response(null, { status: 302, headers: { location: "https://files.oaiusercontent.com/image" } }) : new Response(bytes);
  };
  const result = await client.fetchAssetContent("https://chatgpt.com/backend-api/estuary/content?id=synthetic"); await result.body.cancel();
  assert.equal(calls[0].headers.get("authorization"), "Bearer synthetic-secret");
  assert.equal(calls[1].headers.get("authorization"), null); assert.equal(calls[1].headers.get("cookie"), null);
  for (const url of ["https://chatgpt.com/backend-api/me", "http://files.oaiusercontent.com/image", "https://127.0.0.1/image", "https://files.oaiusercontent.com.attacker.test/image", "https://user:pass@files.oaiusercontent.com/image"]) {
    await assert.rejects(client.fetchAssetContent(url), /Unsupported/);
  }
  assert.equal(calls.length, 2);
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  await assert.rejects(client.fetchAssetContent("https://files.oaiusercontent.com/image"), /Unsupported/);
});

test("preview failure retains a working download capability and encoded paths resolve once", async () => {
  const calls = [];
  globalThis.fetch = async url => {
    const u = new URL(String(url)); calls.push(u);
    if (u.pathname.endsWith("/interpreter/download")) return Response.json({ download_url: "https://chatgpt.com/backend-api/estuary/content?id=synthetic", file_name: "report 20%.png" });
    return new Response("not an image", { status: 403 });
  };
  const client = new ChatGptBackendClient({ accessToken: "synthetic", deviceId: "synthetic" });
  const links = await createAssetLinks(client, "http://127.0.0.1", "sandbox:/mnt/data/report%2020%25.png", "upstream", "answer");
  assert.equal(calls[0].searchParams.get("sandbox_path"), "/mnt/data/report 20%.png");
  assert.equal(links.fileName, "report 20%.png");
  assert.equal(links.previewUnavailable, true);
  assert.ok(store.openAssetTicket(new URL(links.downloadUrl).searchParams.get("ticket")));
});

test("reconnecting the same account invalidates file links even within one millisecond", () => {
  const old = ticket(); session(); assert.equal(store.openAssetTicket(old), null);
});

test("preview limits, missing types and empty bodies retain downloads without broken images", async () => {
  const client = new ChatGptBackendClient({ accessToken: "synthetic", deviceId: "synthetic" });
  for (const variant of ["large", "empty", "untyped", "missing-body", "mime-only"]) {
    globalThis.fetch = async url => String(url).includes("/files/")
      ? Response.json({ download_url: "https://files.oaiusercontent.com/asset", mime_type: "image/png" })
      : variant === "missing-body" ? new Response(null, { status: 204 })
      : new Response(variant === "large" ? Buffer.alloc(25 * 1024 * 1024 + 1) : variant === "empty" ? Buffer.alloc(0) : bytes,
        { headers: variant === "untyped" ? {} : { "content-type": "image/png" } });
    const links = await createAssetLinks(client, "http://127.0.0.1", "file-service://opaque", "upstream", "answer");
    assert.ok(links.downloadUrl.includes("download=1"));
    if (variant === "mime-only") assert.match(links.url, /^data:image\/png;base64,/);
    else assert.equal(links.previewUnavailable, true, variant);
  }
});

test("literal percent filenames, generic downloads, missing tickets and network errors", async () => {
  const client = new ChatGptBackendClient({ accessToken: "synthetic", deviceId: "synthetic" });
  globalThis.fetch = async url => String(url).includes("/download")
    ? Response.json({ download_url: "https://files.oaiusercontent.com/asset" }) : new Response(bytes);
  const links = await createAssetLinks(client, "http://127.0.0.1", "sandbox:/mnt/data/report%.csv", "upstream", "answer");
  assert.equal(links.fileName, "report%.csv");
  const res = await request(new URL(links.downloadUrl).searchParams.get("ticket"));
  assert.equal(res.statusCode, 200); assert.equal(res.headers["content-type"], "application/octet-stream");
  assert.equal((await app.inject({ url: "/api/asset-content" })).statusCode, 404);
  globalThis.fetch = async () => { throw new Error("private upstream failure"); };
  const failure = await request(); assert.equal(failure.statusCode, 502); assert.doesNotMatch(failure.body, /private/);
  const { assetFileName } = await import("../dist/asset-links.js");
  assert.equal(assetFileName("folder/\u0000\n"), "file");
});

test("redirect loops, missing Location and the legacy sandbox resolver", async () => {
  const client = new ChatGptBackendClient({ accessToken: "synthetic", deviceId: "synthetic" });
  globalThis.fetch = async () => new Response("redirect", { status: 302 });
  await assert.rejects(client.fetchAssetContent("https://oaiusercontent.com/image"), /no destination/);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("redirect", { status: 307, headers: { location: "/loop" } }); };
  await assert.rejects(client.fetchAssetContent("https://files.oaiusercontent.com/image"), /Too many/);
  assert.equal(requests, 4);
  globalThis.fetch = async () => Response.json({ download_url: "https://files.oaiusercontent.com/report" });
  assert.equal(await client.resolveSandboxDownload("/mnt/data/report.csv", "conversation", "message"), "https://files.oaiusercontent.com/report");
});

test("capability issuance requires a session and bounds malformed tokens", () => {
  store.clearSession(); assert.throws(ticket, /No session/); session();
  assert.equal(store.openAssetTicket("x".repeat(12001)), null);
  store.saveVerifiedSession("synthetic-session");
  const value = ticket(); assert.ok(store.openAssetTicket(value)); session();
});

test("legacy saved sessions can issue links without changing session credentials", async () => {
  const { writeFileSync } = await import("node:fs");
  const legacyDir = mkdtempSync(path.join(tmpdir(), "mirror-asset-legacy-"));
  try {
    writeFileSync(path.join(legacyDir, "store.json"), JSON.stringify({ session: { sessionToken: "synthetic", savedAt: "2026-01-01" } }));
    process.env.MIRROR_DATA_DIR = legacyDir;
    const legacy = await import(`../dist/store.js?legacy-assets=${Date.now()}`);
    const asset = { pointer: "sandbox:/mnt/data/test.csv", conversationId: null, messageId: null, fileName: "test.csv" };
    assert.deepEqual(legacy.openAssetTicket(legacy.sealAssetTicket(asset)), asset);
  } finally { process.env.MIRROR_DATA_DIR = dir; rmSync(legacyDir, { recursive: true, force: true }); }
});
});
