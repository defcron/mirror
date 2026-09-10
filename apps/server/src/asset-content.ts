import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ChatGptBackendClient, type AssetDownload } from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import { assertSessionRevision, getSessionRevision, onSessionChange, openAssetTicket, sealAssetTicket } from "./store.js";

import { assetFileName, type AssetLinks } from "./asset-links.js";

export async function resolveDownload(client: ChatGptBackendClient, pointer: string, conversationId: string | null, messageId: string | null, signal?: AbortSignal): Promise<AssetDownload> {
  return pointer.startsWith("sandbox:")
    ? client.resolveSandboxDownloadMetadata(decodePath(pointer.slice("sandbox:".length)), conversationId, messageId, signal)
    : client.resolveAssetDownloadMetadata(pointer, conversationId, signal);
}

/** Mint only from assets selected from this turn's visible upstream output. */
export async function createAssetLinks(client: ChatGptBackendClient, origin: string, pointer: string, conversationId: string | null, messageId: string | null, signal?: AbortSignal, image = false): Promise<AssetLinks> {
  const revision = getSessionRevision();
  const metadata = await resolveDownload(client, pointer, conversationId, messageId, signal);
  assertSessionRevision(revision);
  const fileName = assetFileName(metadata.fileName || (pointer.startsWith("sandbox:") ? decodePath(pointer) : "file"));
  const ticket = sealAssetTicket({ pointer, conversationId, messageId, fileName });
  const url = new URL("/api/asset-content", origin);
  url.searchParams.set("ticket", ticket);
  let previewUrl = url.href;
  url.searchParams.set("download", "1");
  const wantsPreview = image || pointer.startsWith("sediment:") || metadata.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(fileName);
  let previewUnavailable = false;
  if (wantsPreview) {
    // A search page cannot reliably load loopback images (Local Network
    // Access), or authenticated Estuary URLs. A self-contained image works
    // in ChatGPTBox's Markdown renderer without either browser permission.
    try {
      const response = await client.fetchAssetContent(metadata.url, signal);
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
      if (!response.ok || !response.body || !previewMimeType(mimeType)) {
        await response.body?.cancel();
        throw new Error("Preview unavailable");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 25 * 1024 * 1024) throw new Error("Preview too large");
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (!size) throw new Error("Empty preview");
      previewUrl = `data:${mimeType};base64,${Buffer.concat(chunks).toString("base64")}`;
    } catch { previewUnavailable = true; }
    signal?.throwIfAborted();
    assertSessionRevision(revision);
  }
  return { url: previewUrl, downloadUrl: url.href, fileName, mimeType: metadata.mimeType, ...(previewUnavailable ? { previewUnavailable } : {}) };
}

const previewMimeType = (value: string) => /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd.microsoft.icon|svg\+xml)$/.test(value);

function decodePath(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export async function registerAssetContentRoute(app: FastifyInstance): Promise<void> {
  app.get("/api/asset-content", async (req, reply) => {
    // The ticket replaces ambient browser credentials for this one asset only.
    // Query strings are stripped by the server request logger.
    reply.header("cache-control", "no-store");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "default-src 'none'; sandbox");
    reply.header("cross-origin-resource-policy", "cross-origin");
    const query = req.query as Record<string, unknown>;
    const ticket = typeof query.ticket === "string" ? openAssetTicket(query.ticket) : null;
    if (!ticket) return reply.code(404).send({ error: "File link expired or unavailable. Request a new file link in chat." });
    const revision = getSessionRevision();
    const controller = new AbortController();
    const unsubscribe = onSessionChange(() => controller.abort());
    const timer = setTimeout(() => controller.abort(), 120_000);
    req.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => { clearTimeout(timer); unsubscribe(); controller.abort(); });
    try {
      const client = new ChatGptBackendClient(await getValidCredentials());
      assertSessionRevision(revision);
      const metadata = await resolveDownload(client, ticket.pointer, ticket.conversationId, ticket.messageId, controller.signal);
      assertSessionRevision(revision);
      const response = await client.fetchAssetContent(metadata.url, controller.signal);
      assertSessionRevision(revision);
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        return reply.code(502).send({ error: "File is currently unavailable upstream. Request a new file link in chat." });
      }
      const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "application/octet-stream";
      const preview = query.download !== "1" && previewMimeType(mimeType);
      const fileName = assetFileName(metadata.fileName || ticket.fileName);
      const asciiName = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
      const encodedName = encodeURIComponent(fileName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      reply.type(mimeType);
      reply.header("content-disposition", `${preview ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
      if (req.method === "HEAD") { await response.body.cancel(); return reply.send(); }
      // Stream bytes with backpressure; never buffer a whole generated file.
      return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
    } catch {
      clearTimeout(timer);
      return reply.code(502).send({ error: "File is currently unavailable. Request a new file link in chat." });
    }
  });
}
