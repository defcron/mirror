/** Optional integration check against an installed checkout of ChatGPTBox.
 * CHATGPTBOX_SOURCE=/path/to/chatGPTBox node scripts/check-chatgptbox-assets.mjs
 * Uses its real MarkdownRender/Hyperlink components, a synthetic backend and
 * real Chromium image loads/downloads. Does not use a personal browser profile.
 * MIRROR_ASSET_RESPONSE=/path/to/response.json replays {markdown} from the live
 * QA prompt producing mirror-preview-qa.png and mirror-download-qa.csv.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import chromiumBinary from "chromium";
const source = process.env.CHATGPTBOX_SOURCE;
if (!source) throw new Error("Set CHATGPTBOX_SOURCE to a ChatGPTBox checkout with npm dependencies installed.");
const dir = mkdtempSync(path.join(tmpdir(), "mirror-chatgptbox-assets-"));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = "synthetic-key";
delete process.env.MIRROR_STORE_KEY;
const { buildApp } = await import("../apps/server/dist/index.js");
const store = await import("../apps/server/dist/store.js");
const { stubBackend } = await import("../apps/server/tests/helpers/backend.mjs");
const app = await buildApp();
const address = await app.listen({ host: "127.0.0.1", port: 0 });
store.saveVerifiedSession("synthetic-session", "renderer-account", "synthetic-device");
store.updateMintedToken("synthetic-upstream-access", Date.now() + 3600000, null);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const originalFetch = globalThis.fetch;
const backend = stubBackend("renderer-account", { turnFrames: () => [
  { p: "", o: "add", v: { conversation_id: "synthetic-conversation", message: {
    id: "answer", author: { role: "assistant" }, content: { content_type: "text", parts: ["Here is your preview:\n\n![preview](sandbox:/mnt/data/preview.png)\n\n[Download now](sandbox:/mnt/data/report.csv)"] }, status: "finished_successfully",
  } } }, "[DONE]",
] });
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith("/interpreter/download")) {
    const filename = u.searchParams.get("sandbox_path").split("/").at(-1);
    return Response.json({ download_url: `https://chatgpt.com/backend-api/estuary/content?file=${filename}`, file_name: filename });
  }
  if (u.pathname === "/backend-api/estuary/content") {
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-upstream-access");
    const image = u.searchParams.get("file") === "preview.png";
    return new Response(image ? png : "name,value\nQA,42\n", { headers: { "content-type": image ? "image/png" : "text/csv" } });
  }
  return backend(url, init);
};
let browser;
try {
  let markdown;
  const liveResponse = process.env.MIRROR_ASSET_RESPONSE;
  const csvName = liveResponse ? "mirror-download-qa.csv" : "report.csv";
  if (liveResponse) markdown = JSON.parse(readFileSync(liveResponse, "utf8")).markdown;
  else {
    const response = await originalFetch(`${address}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer synthetic-key", "content-type": "application/json" }, body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "Generate the QA assets" }], stream: true }) });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)));
    markdown = frames.map(f => f.choices?.[0]?.delta?.content ?? "").join("");
  }
  const results = [];
  console.log("Building ChatGPTBox renderer");
  for (const variant of ["markdown.jsx", "markdown-without-katex.jsx"]) {
    const bundle = await build({ stdin: { contents: `import {createElement,render} from 'preact'; import Markdown from ${JSON.stringify(path.join(source, "src/components/MarkdownRender", variant))}; window.renderAnswer=(text)=>render(createElement(Markdown,{children:text}),document.getElementById('answer'));`, resolveDir: source, loader: "jsx" }, resolveExtensions: [".mjs", ".js", ".jsx", ".json"], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", jsxImportSource: "preact", loader: { ".css": "empty" }, plugins: [{ name: "browser-message-stub", setup(b) { b.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: "browser-message-stub", namespace: "qa" })); b.onLoad({ filter: /.*/, namespace: "qa" }, () => ({ contents: "export default {runtime:{sendMessage(){throw new Error('Asset link should use a normal anchor')}}}" })); } }] });
    browser ??= await chromium.launch({ executablePath: chromiumBinary.path, headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.on("pageerror", error => console.log("Renderer error:", error.message));
    page.on("console", message => { if(message.type() === "error") console.log("Browser error:", message.text().replace(/ticket=[^\s]+/g,"ticket=omitted")); });
    page.on("requestfailed", req => console.log("Request failure:", new URL(req.url()).pathname, req.failure()?.errorText));
    // A controlled HTTPS search-page fixture. Browser security remains enabled.
    await page.route("https://www.google.com/search?mirror-assets-qa", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><main id="answer" style="max-width:460px"></main></body></html>' }));
    await page.goto("https://www.google.com/search?mirror-assets-qa");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(value => window.renderAnswer(value), markdown);
    await page.waitForFunction(() => { const img = document.querySelector("#answer img"); return img?.complete && img.naturalWidth > 0; }, undefined, { timeout: 15000 });
    const link = page.getByRole("link", { name: csvName, exact: true });
    assert.equal(await link.getAttribute("target"), "_blank");
    assert.ok((await page.locator("#answer").innerText()).includes(`Download file: ${csvName}`));
    const downloaded = page.waitForEvent("download", { timeout: 15000 });
    await link.click();
    const file = await downloaded;
    assert.equal(file.suggestedFilename(), csvName);
    const downloadedBytes = readFileSync(await file.path());
    assert.equal(downloadedBytes.toString("utf8"), "name,value\nQA,42\n");
    results.push({ variant, previewLoaded: true, filename: file.suggestedFilename(), downloadedBytes: downloadedBytes.length });
    await context.close();
  }
  console.log(JSON.stringify({ passed: true, evidence: "ChatGPTBox source renderer in Chromium on a controlled HTTPS search-page fixture; real asset HTTP transport", upstream: liveResponse ? "live Mirror response" : "synthetic", results }));
} finally {
  globalThis.fetch = originalFetch;
  await browser?.close(); await app.close(); rmSync(dir, { recursive: true, force: true });
}
