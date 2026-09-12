/**
 * Pure helper functions extracted from openai.ts's route handler: model
 * routing, request-content normalization, prompt/history synthesis, and
 * response-metadata packing. None of this depends on Fastify or the route
 * handler itself - it's plain data transformation - so it lives separately
 * to keep openai.ts focused on request/response wiring. Behavior is
 * unchanged from before this split; only the file boundary moved.
 */
import { z } from "zod";
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
  upstreamConversationId: string | null,
): Record<string, string> | undefined {
  const toolEvents = events.filter(
    (event): event is Extract<NormalizedConversationEvent, { kind: "tool" }> =>
      event.kind === "tool" && !event.displayHidden,
  );
  const imageEvents = events.filter(
    (event): event is Extract<NormalizedConversationEvent, { kind: "image" }> =>
      (event.kind === "image" || (event.kind === "file" && typeof (event as any).assetPointer === "string" && (event as any).assetPointer.startsWith("sediment://"))) && !event.displayHidden,
  );
  const metadata: Record<string, string> = {};
  if (toolEvents.length) {
    metadata.mirror_tool_events = JSON.stringify(
      toolEvents.map((event) => ({ name: event.name, status: event.status ?? null })),
    );
  }
  if (imageEvents.length) {
    const query = (pointer: string) => {
      const params = new URLSearchParams({ pointer });
      if (upstreamConversationId) params.set("upstreamConversationId", upstreamConversationId);
      return `/api/assets?${params.toString()}`;
    };
    metadata.mirror_images = JSON.stringify(
      imageEvents.map((event) => ({ url: query(event.assetPointer) })),
    );
  }
  return Object.keys(metadata).length ? metadata : undefined;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // matches /api/files' multipart cap

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
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.startsWith("169.254.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.")
    ) {
      throw new Error(`image_url[${index}] host is not permitted: ${host}`);
    }
    const res = await fetch(url, { signal, redirect: "follow" });
    if (!res.ok)
      throw new Error(`Could not fetch image_url[${index}]: upstream returned ${res.status}`);
    const cl = res.headers.get("content-length");
    if (cl && Number(cl) > MAX_IMAGE_BYTES) {
      throw new Error(`image_url[${index}] is too large (${cl} bytes, max ${MAX_IMAGE_BYTES})`);
    }
    mimeType = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    const reader = res.body?.getReader();
    if (!reader) {
      data = new Uint8Array(await res.arrayBuffer());
    } else {
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
      data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
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
