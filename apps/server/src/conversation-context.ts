/**
 * Pure helper functions extracted from openai.ts's route handler: model
 * routing, request-content normalization, prompt/history synthesis, and
 * response-metadata packing. None of this depends on Fastify or the route
 * handler itself - it's plain data transformation - so it lives separately
 * to keep openai.ts focused on request/response wiring. Behavior is
 * unchanged from before this split; only the file boundary moved.
 */
import { z } from "zod";
import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent } from "undici";
import {
  ChatGptBackendClient,
  type NormalizedConversationEvent,
  type UploadedFile,
} from "@mirror/protocol";
import { fingerprintValue } from "./store.js";
import type { OpenAiMessage, TextPart, ContentPart } from "./openai.js";

/**
 * Model routing: official model slugs pass through unchanged. Gizmo-backed
 * "models" (Custom GPTs and ChatGPT Projects, aka "snorlax") share one id
 * namespace upstream - Custom GPTs are "g-<hex>", Projects are "g-p-<hex>" -
 * so both route through the same gizmoId mechanism chat-service.ts already
 * supports end-to-end. A Project (or GPT) can pick its own model via
 * metadata.mirror_model - including, experimentally, another gizmo/project
 * id nested inside it; we don't validate that shape, we just forward it and
 * let upstream decide what to do with it.
 */
export function routeModel(
  model: string,
  metadata?: Record<string, string>,
): { model?: string; gizmoId?: string | null; private?: boolean } {
  const override = metadata?.mirror_model;
  const privateMode =
    metadata?.private === undefined ? undefined : metadata.private === "true";
  if (/^g-/.test(model))
    return {
      model: override || "auto",
      gizmoId: model,
      ...(privateMode !== undefined ? { private: privateMode } : {}),
    };
  return {
    model: override || model,
    ...(privateMode !== undefined ? { private: privateMode } : {}),
  };
}

export function textContent(
  content: z.infer<typeof OpenAiMessage>["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is z.infer<typeof TextPart> => part.type === "text" && Boolean(part.text))
    .map((part) => part.text)
    .join("\n");
}

/**
 * Packs ChatGPT-only behavior that has no slot in the official Chat
 * Completions response schema into documented metadata.mirror_* keys (see
 * CompletionBody's doc comment above) - undefined when there's nothing to
 * report, so ordinary turns don't grow a metadata object at all.
 */
export function buildResponseMetadata(
  events: NormalizedConversationEvent[],
  _upstreamConversationId: string | null,
): Record<string, string> | undefined {
  const toolEvents = events.filter(
    (event): event is Extract<NormalizedConversationEvent, { kind: "tool" }> =>
      event.kind === "tool" && !event.displayHidden,
  );
  const metadata: Record<string, string> = {};
  if (toolEvents.length) {
    metadata.mirror_tool_events = JSON.stringify(
      toolEvents.map((event) => ({ name: event.name, status: event.status ?? null })),
    );
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // matches /api/files' multipart cap
const MAX_IMAGE_REDIRECTS = 5;

const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [address, prefix, family] of [
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"], ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
] as const) NON_PUBLIC_ADDRESSES.addSubnet(address, prefix, family);

export function isPublicImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  const family = isIP(host);
  return family === 0 || !NON_PUBLIC_ADDRESSES.check(host, family === 4 ? "ipv4" : "ipv6");
}

type AddressResolver = (
  hostname: string,
  options: { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void,
) => void;

export function makePublicLookup(resolve: AddressResolver = lookup as AddressResolver): LookupFunction {
  return (hostname, options, callback) => resolve(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    const permitted = addresses.filter(({ address }) => isPublicImageHost(address));
    if (!permitted.length) {
      const denied = Object.assign(new Error(`image host resolves to a non-public address: ${hostname}`), { code: "EACCES" });
      return callback(denied, "", 4);
    }
    if (options.all) return callback(null, permitted as never);
    const first = permitted[0]!;
    return callback(null, first.address, first.family);
  });
}

export const publicLookup = makePublicLookup();

async function fetchPublicImage(url: string, signal: AbortSignal | undefined, index: number) {
  const agent = new Agent({ connect: { lookup: publicLookup } });
  let current = new URL(url);
  try {
    for (let redirects = 0; ; redirects += 1) {
      if (!isPublicImageHost(current.hostname))
        throw new Error(`image_url[${index}] host is not permitted: ${current.hostname}`);
      const res = await fetch(current, {
        signal,
        redirect: "manual",
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent });
      if (![301, 302, 303, 307, 308].includes(res.status)) {
        if (!res.ok)
          throw new Error(`Could not fetch image_url[${index}]: upstream returned ${res.status}`);
        const cl = res.headers.get("content-length");
        if (cl && Number(cl) > MAX_IMAGE_BYTES)
          throw new Error(`image_url[${index}] is too large (${cl} bytes, max ${MAX_IMAGE_BYTES})`);
        const mimeType = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
        const reader = res.body?.getReader();
        if (!reader) return { data: new Uint8Array(await res.arrayBuffer()), mimeType };
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel().catch(() => {});
            throw new Error(`image_url[${index}] is too large (${total} bytes, max ${MAX_IMAGE_BYTES})`);
          }
          chunks.push(value);
        }
        const data = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { data, mimeType };
      }
      if (redirects >= MAX_IMAGE_REDIRECTS)
        throw new Error(`Could not fetch image_url[${index}]: too many redirects`);
      const location = res.headers.get("location");
      if (!location)
        throw new Error(`Could not fetch image_url[${index}]: redirect has no location`);
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:")
        throw new Error(`image_url[${index}] redirect protocol is not permitted`);
    }
  } finally {
    await agent.close();
  }
}

export function imagePartsOf(
  content: z.infer<typeof OpenAiMessage>["content"],
): Extract<z.infer<typeof ContentPart>, { type: "image_url" }>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Extract<z.infer<typeof ContentPart>, { type: "image_url" }> =>
      part.type === "image_url",
  );
}

const DATA_URL_RE = /^data:([^;,]+)(;charset=[^;,]+)?(;base64)?,(.*)$/s;

/**
 * Resolves one OpenAI-shape image_url part into an uploaded backend-api
 * file. backend-api has no notion of "reference this image by URL" the way
 * the official API's vision input does - every attachment has to already
 * exist as a file the account owns (see ChatGptBackendClient.uploadFile /
 * POST /api/files), so a data: URI is decoded and an https URL is fetched,
 * then both are uploaded the same way a browser attachment would be.
 */
export async function resolveImageAttachment(
  client: ChatGptBackendClient,
  part: Extract<z.infer<typeof ContentPart>, { type: "image_url" }>,
  index: number,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const url = part.image_url.url;
  let data: Uint8Array;
  let mimeType: string;
  const dataUrlMatch = DATA_URL_RE.exec(url);
  if (dataUrlMatch) {
    const [, declaredType, , isBase64, payload] = dataUrlMatch;
    mimeType = declaredType;
    data = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf-8");
  } else if (/^https?:\/\//i.test(url)) {
    ({ data, mimeType } = await fetchPublicImage(url, signal, index));
  } else {
    throw new Error(
      `image_url[${index}] must be a data: URI or an http(s) URL`,
    );
  }
  if (!mimeType.startsWith("image/"))
    throw new Error(`image_url[${index}] does not look like an image (got ${mimeType})`);
  if (data.byteLength === 0)
    throw new Error(`image_url[${index}] resolved to an empty file`);
  if (data.byteLength > MAX_IMAGE_BYTES)
    throw new Error(
      `image_url[${index}] is too large (${data.byteLength} bytes, max ${MAX_IMAGE_BYTES})`,
    );
  const extension = mimeType.split("/")[1]?.split("+")[0] || "png";
  return client.uploadFile({
    data,
    fileName: `image-${index}.${extension}`,
    mimeType,
    signal,
  });
}

export function normalized(messages: z.infer<typeof OpenAiMessage>[]) {
  return messages.map((message) => ({
    role: message.role,
    content: textContent(message.content),
    ...(message.name ? { name: message.name } : {}),
  }));
}

export function promptFor(
  messages: ReturnType<typeof normalized>,
  continuation: boolean,
): string {
  if (continuation) return messages.at(-1)!.content;
  const system = messages.filter(
    (m) => m.role === "system" || m.role === "developer",
  );
  const conversational = messages.filter(
    (m) => m.role !== "system" && m.role !== "developer",
  );
  if (messages.length === 1 && messages[0]?.role === "user")
    return messages[0].content;
  return [
    system.length
      ? `Instructions:\n${system.map((m) => m.content).join("\n")}`
      : "",
    "Conversation context:",
    conversational
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function instructionsHash(messages: ReturnType<typeof normalized>): string {
  return fingerprintValue(
    messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    ),
  );
}

export function conversationalMessages(messages: ReturnType<typeof normalized>) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}

export function firstHistoryDifference(
  stored: Array<{ role: "user" | "assistant"; content: string }>,
  incoming: Array<{ role: "user" | "assistant"; content: string }>,
): number {
  let index = 0;
  while (
    index < stored.length &&
    index < incoming.length &&
    stored[index]?.role === incoming[index]?.role &&
    stored[index]?.content === incoming[index]?.content
  ) {
    index += 1;
  }
  return index;
}
