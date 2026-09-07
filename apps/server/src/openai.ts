import "./zod-openapi-init.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ChatGptBackendClient,
  normalizeGizmos,
  normalizeModels,
  type NormalizedConversationEvent,
  type UploadedFile,
} from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import { runChat } from "./chat-service.js";
import {
  getSessionRevision,
  saveFile,
  assertSessionRevision,
  saveInstructions,
  fingerprintValue,
  findConversationByTranscript,
  getConversation,
  getOpenAiContext,
  getOpenAiTranscript,
  getSession,
  listMessages,
  rebaseConversationUpstream,
  replaceMessages,
  saveOpenAiContext,
  saveOpenAiTranscript,
  type StoredConversation,
} from "./store.js";

const TextPart = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict()
  .openapi({ description: "Plain text content part." });
/**
 * Official OpenAI vision content part. `url` accepts a data: URI (uploaded
 * inline, the common case for API callers) or an https URL (fetched
 * server-side and re-uploaded to ChatGPT's file service, since backend-api
 * has no concept of "point at this external URL" - every attachment has to
 * exist as an uploaded file first, see resolveImageAttachment below).
 * `detail` is accepted for OpenAI-shape compatibility but has no backend-api
 * equivalent (ChatGPT does not expose a client-selectable vision resolution
 * tier), so it's parsed and silently ignored rather than rejected.
 */
const ImageUrlPart = z
  .object({
    type: z.literal("image_url"),
    image_url: z
      .object({
        url: z.string().openapi({
          description:
            "A data: URI (uploaded inline) or an https:// URL (fetched server-side). " +
            "Mirror uploads the resolved image to ChatGPT's file service before sending " +
            "the turn - backend-api has no concept of pointing at an external URL directly.",
        }),
        detail: z
          .enum(["auto", "low", "high"])
          .optional()
          .openapi({
            description:
              "Accepted for OpenAI shape-compatibility but has no backend-api equivalent " +
              "(no client-selectable vision resolution tier exists upstream); parsed and ignored.",
          }),
      })
      .strict(),
  })
  .strict()
  .openapi({
    description:
      "Vision input content part. See COMPATIBILITY.md for how this maps onto ChatGPT's " +
      "own file-upload flow.",
  });
const ContentPart = z.union([TextPart, ImageUrlPart]).openapi({ ref: "ContentPart" });
const OpenAiMessage = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]).openapi({
      description:
        "'tool' is accepted by this schema's shape but rejected at request time - tool/" +
        "function calling is a structural two-way gap between backend-api and the official " +
        "OpenAI tools contract. See COMPATIBILITY.md.",
    }),
    content: z.union([z.string(), z.array(ContentPart), z.null()]),
    name: z.string().optional(),
  })
  .passthrough()
  .openapi({ ref: "ChatMessage" });
const CompletionBody = z
  .object({
    model: z.string().default("auto").openapi({
      description: "A ChatGPT model slug, or a Custom GPT/Project id from GET /v1/models.",
      example: "gpt-4o",
    }),
    messages: z.array(OpenAiMessage).min(1),
    stream: z.boolean().default(false),
    /**
     * Official OpenAI field, repurposed rather than adding a new one: whether
     * this turn is attached to a continuable Mirror conversation thread.
     * Defaults to true (persistent threads by default, mirroring how real
     * ChatGPT conversations behave); pass store:false for a one-shot message
     * that will not be resumable by a later /v1/chat/completions call.
     */
    store: z.boolean().default(true),
    /**
     * Official field. backend-api has no upstream concept of a token
     * ceiling, so this is enforced Mirror-side by approximating a character
     * budget (see CHARS_PER_TOKEN_ESTIMATE below) and cutting the response
     * off once it's exceeded - it is NOT the same as the real API actually
     * stopping generation early upstream (ChatGPT keeps generating the full
     * reply regardless; Mirror still stores that full reply locally so a
     * continued conversation has the real context, and only trims what this
     * endpoint hands back). finish_reason is reported as "length" when this
     * fires. `max_completion_tokens` takes precedence over `max_tokens` if
     * both are given, matching official precedence.
     */
    max_tokens: z.number().int().positive().optional().openapi({
      description:
        "Soft approximation only: backend-api has no hard token ceiling per turn, so Mirror " +
        "estimates tokens from characters (~4 chars/token) and cuts the returned text once " +
        "the estimate is exceeded; the underlying ChatGPT turn still runs to completion and " +
        "is stored in full locally. Not an exact enforced limit - see COMPATIBILITY.md.",
    }),
    max_completion_tokens: z.number().int().positive().optional().openapi({
      description: "Same soft approximation as max_tokens; takes precedence if both are set.",
    }),
    /**
     * Official field. Same caveat as max_tokens: no upstream stop-sequence
     * support exists, so this is a Mirror-side "watch the stream and cut it
     * off" implementation - the underlying ChatGPT turn still runs to
     * completion (and is stored in full locally), only the text handed back
     * through this endpoint is trimmed at the first match. finish_reason is
     * reported as "stop" when this fires (same value the API already uses
     * for a natural end of turn, matching official semantics).
     */
    stop: z
      .union([z.string(), z.array(z.string().min(1)).min(1).max(4)])
      .optional()
      .openapi({
        description:
          "One string, or up to 4 strings. Backend-api has no native stop-sequence support; " +
          "Mirror watches the streamed text client-side and cuts the response off at the " +
          "first match. Soft approximation, not upstream-enforced - see COMPATIBILITY.md.",
      }),
    /**
     * Official OpenAI field (free-form string metadata), repurposed for
     * Mirror-specific routing so the request body needs no non-standard
     * fields. Recognized keys:
     *  - metadata.private = "true"      -> temporary/incognito chat, excluded
     *                                       from chatgpt.com history & training
     *  - metadata.mirror_model = "..."  -> the actual model (or another gizmo/
     *                                       project id) to run when `model` is
     *                                       itself a gizmo/project id, i.e. a
     *                                       Project's picked model
     *  - metadata.conversation_id = "..." -> reuse an id returned via the
     *                                       x-mirror-conversation-id response
     *                                       header to continue that thread, or
     *                                       supply your own new id up front to
     *                                       name a brand-new conversation.
     *                                       Optional: a client that always
     *                                       resends its full message history
     *                                       itself (rather than tracking a
     *                                       conversation id at all - e.g. a
     *                                       plain "OpenAI-compatible API"
     *                                       mode in a browser extension)
     *                                       still gets threaded onto the
     *                                       same Mirror conversation
     *                                       automatically, by recognizing
     *                                       its resent history. See
     *                                       findConversationByTranscript in
     *                                       store.ts.
     *
     * Editing an earlier user turn in a resent history for an explicit
     * conversation_id rebases that Mirror conversation as a new branch
     * inside the existing upstream ChatGPT thread. Assistant turns are
     * immutable and requests that change or remove one are rejected. Both
     * the upstream and caller-facing conversation ids stay unchanged. See
     * rebaseConversationUpstream/replaceMessages in store.ts.
     *
     * The response's own `metadata` object (both the non-streaming
     * chat.completion object and the final streaming chunk) uses this same
     * mechanism in the other direction: it's how Mirror surfaces ChatGPT
     * product behavior that has no field anywhere in the official Chat
     * Completions response schema, without inventing new top-level response
     * fields a strict OpenAI-response parser might choke on. Response-only
     * keys (never meaningful in a request):
     *  - metadata.mirror_tool_events = "[...]"  -> present only when ChatGPT
     *                                       invoked one of its own built-in
     *                                       tools this turn (web browsing,
     *                                       the Python/code-interpreter
     *                                       sandbox, etc - see
     *                                       COMPATIBILITY.md). A JSON array
     *                                       of {name, status} objects, in
     *                                       the order observed. This is
     *                                       purely informational: there is
     *                                       no way to define a *new* tool or
     *                                       intercept these calls, only to
     *                                       see that ChatGPT's own ones ran.
     *  - metadata.mirror_images = "[...]"  -> present only when the turn
     *                                       included a generated image (the
     *                                       in-chat DALL-E tool, distinct
     *                                       from POST /v1/images/generations
     *                                       which has no ChatGPT-web
     *                                       equivalent at all). A JSON array
     *                                       of {url} objects; each url is a
     *                                       path (resolve it against the
     *                                       same base_url used for /v1) to
     *                                       Mirror's own GET /api/assets,
     *                                       which streams the actual image
     *                                       bytes back with your Mirror API
     *                                       key.
     * Every metadata value, request or response, is a JSON-stringified
     * string rather than a nested object, since the official metadata field
     * is documented as flat string:string pairs - Mirror never puts a raw
     * object where the official schema expects a string. Mirror does not
     * enforce OpenAI's own request-side metadata limits (16 keys, 64-char
     * keys, 512-char values) on these response-only keys, since they are a
     * Mirror-specific extension the official API never validates.
     */
    metadata: z
      .object({
        private: z.enum(["true", "false"]).optional().openapi({
          description: "Request ChatGPT's temporary/incognito chat mode for this turn.",
        }),
        mirror_model: z.string().min(1).optional().openapi({
          description:
            "Override the effective ChatGPT model slug independent of the model field " +
            "(e.g. picking a Project's underlying model).",
        }),
        conversation_id: z.string().min(1).max(200).optional().openapi({
          description: "Continue an existing Mirror conversation by id.",
        }),
      })
      .strict()
      .optional()
      .openapi({
        description:
          "Officially a flat request-only string map in the real OpenAI API; Mirror " +
          "repurposes it (bidirectionally - the response carries its own mirror_tool_events/" +
          "mirror_images keys here too, see the response schema) for anything with no " +
          "dedicated schema slot. Any key not listed here is passed through unused. See " +
          "COMPATIBILITY.md.",
      }),
  })
  .strict()
  .openapi({
    ref: "CompletionRequest",
    description:
      "OpenAI Chat Completions-shaped request, backed by chatgpt.com/backend-api. " +
      "Unsupported fields are rejected (400) rather than silently ignored.",
  });

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
function routeModel(
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

function textContent(
  content: z.infer<typeof OpenAiMessage>["content"],
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is z.infer<typeof TextPart> => part.type === "text" && Boolean(part.text))
    .map((part) => part.text)
    .join("\n");
}

// Rough, documented approximation - backend-api has no tokenizer endpoint to
// call, and ChatGPT's own real tokenization varies by model. This exists
// only to give max_tokens/max_completion_tokens *some* effect rather than
// none; see the CompletionBody doc comment above for the full caveat.
const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Client-side stand-in for upstream stop-sequence/max-token support (neither
 * exists in backend-api - see CompletionBody above). Watches the growing
 * `full` text as deltas arrive and decides, once, where the response handed
 * back to the caller should be cut. The underlying ChatGPT turn is never
 * itself interrupted - the cutoff only affects what this endpoint forwards
 * and returns, not what actually gets generated or stored locally.
 */
function createTurnLimiter(stopSequences: string[], charBudget: number | null) {
  let cutIndex: number | null = null;
  let finishReason: "stop" | "length" | null = null;
  let forwarded = 0;

  function scan(full: string) {
    if (cutIndex !== null) return;
    if (charBudget !== null && full.length >= charBudget) {
      cutIndex = charBudget;
      finishReason = "length";
    }
    for (const stopSeq of stopSequences) {
      const idx = stopSeq ? full.indexOf(stopSeq) : -1;
      if (idx !== -1 && (cutIndex === null || idx < cutIndex)) {
        cutIndex = idx;
        finishReason = "stop";
      }
    }
  }

  return {
    /** Streaming only: given the newest delta and the full text so far, returns the slice of `delta` still safe to forward, or null once the cutoff has already been reached (nothing more should be sent). */
    feed(delta: string, full: string): string | null {
      scan(full);
      const limit = cutIndex === null ? full.length : cutIndex;
      if (forwarded >= limit) return null;
      const safe = full.slice(forwarded, limit);
      forwarded = limit;
      return safe;
    },
    /** Final assembly for both modes: given the complete text, the truncated text to report plus the finish_reason to use. */
    finalize(full: string): { text: string; finishReason: "stop" | "length" } {
      scan(full);
      return {
        text: cutIndex === null ? full : full.slice(0, cutIndex),
        finishReason: finishReason ?? "stop",
      };
    },
  };
}

/**
 * Packs ChatGPT-only behavior that has no slot in the official Chat
 * Completions response schema into documented metadata.mirror_* keys (see
 * CompletionBody's doc comment above) - undefined when there's nothing to
 * report, so ordinary turns don't grow a metadata object at all.
 */
function buildResponseMetadata(
  events: NormalizedConversationEvent[],
  upstreamConversationId: string | null,
): Record<string, string> | undefined {
  const toolEvents = events.filter(
    (event): event is Extract<NormalizedConversationEvent, { kind: "tool" }> =>
      event.kind === "tool",
  );
  const imageEvents = events.filter(
    (event): event is Extract<NormalizedConversationEvent, { kind: "image" }> =>
      event.kind === "image",
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

function imagePartsOf(
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
async function resolveImageAttachment(
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
    const res = await fetch(url, { signal });
    if (!res.ok)
      throw new Error(`Could not fetch image_url[${index}]: upstream returned ${res.status}`);
    mimeType = res.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
    data = new Uint8Array(await res.arrayBuffer());
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

function normalized(messages: z.infer<typeof OpenAiMessage>[]) {
  return messages.map((message) => ({
    role: message.role,
    content: textContent(message.content),
    ...(message.name ? { name: message.name } : {}),
  }));
}

function promptFor(
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

function instructionsHash(messages: ReturnType<typeof normalized>): string {
  return fingerprintValue(
    messages.filter(
      (message) => message.role === "system" || message.role === "developer",
    ),
  );
}

function conversationalMessages(messages: ReturnType<typeof normalized>) {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }));
}

function firstHistoryDifference(
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

function sse(reply: FastifyReply, data: unknown): void {
  reply.raw.write(
    `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
  );
}

/**
 * Serializes overlapping /v1/chat/completions calls that target the same
 * explicit metadata.conversation_id - a double-click, a retry fired before
 * the first request's response landed, an eager client, etc - so a second
 * concurrent call waits for the first to finish instead of racing it. Left
 * unserialized, both calls independently read the same "current head" and
 * each branch off it, sending two sibling messages under the same parent to
 * the real upstream conversation at once: this is what produces "two
 * assistant replies in a row with no user message in between" and a GPT
 * noticing a partial/garbled follow-up.
 */
const conversationLocks = new Map<string, Promise<unknown>>();
function withConversationLock<T>(
  key: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key) return fn();
  const prior = conversationLocks.get(key) ?? Promise.resolve();
  const queued = prior.catch(() => undefined);
  const settled = queued.then(fn);
  const tracked = settled.catch(() => undefined);
  conversationLocks.set(key, tracked);
  tracked.finally(() => {
    if (conversationLocks.get(key) === tracked) conversationLocks.delete(key);
  });
  return settled;
}

/**
 * Exported purely so openapi-document.ts can derive /mirror/openapi's
 * request-body schema from the exact same Zod schema this route validates
 * against, instead of maintaining a second, hand-written copy that can
 * silently drift out of sync with what the server actually accepts.
 */
export { CompletionBody, OpenAiMessage, ContentPart };

export async function registerOpenAiRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get("/v1/models", async () => {
    const creds = await getValidCredentials();
    const client = new ChatGptBackendClient(creds);
    const [models, projectsRaw, gptsRaw] = await Promise.all([
      normalizeModels(await client.fetchModels()),
      client
        .fetchGizmoSidebar({
          ownedOnly: false,
          limit: 50,
          conversationsPerGizmo: 0,
        })
        .catch(() => ({})),
      client.fetchGizmoBootstrap({ limit: 20 }).catch(() => ({})),
    ]);
    const seen = new Set<string>();
    const gizmos = [
      ...normalizeGizmos(gptsRaw),
      ...normalizeGizmos(projectsRaw),
    ].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return {
      object: "list",
      data: [
        ...models.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "chatgpt-web",
          mirror: { supported: !model.id.endsWith("-wm"), execution_mode: model.id.endsWith("-wm") ? "unsupported_work" : "interactive", capabilities: model.capabilities ?? null },
        })),
        ...gizmos.map((gizmo) => ({
          id: gizmo.id,
          object: "model",
          created: 0,
          owned_by: gizmo.id.startsWith("g-p-")
            ? "chatgpt-project"
            : "chatgpt-gizmo",
          name: gizmo.name,
        })),
      ],
    };
  });

  app.post("/v1/chat/completions", async (req: FastifyRequest, reply) => {
    const parsed = CompletionBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
          type: "invalid_request_error",
        },
      });
    }
    const requestRevision = getSessionRevision();
    const body = parsed.data;
    if ((body.metadata?.mirror_model ?? body.model).endsWith("-wm")) return reply.code(400).send({ error: {message: "Work Mode is not supported by Mirror; select an interactive model", type: "unsupported_parameter"} });
    const stopSequences = body.stop === undefined ? [] : Array.isArray(body.stop) ? body.stop : [body.stop];
    const tokenBudget = body.max_completion_tokens ?? body.max_tokens ?? null;
    const limiter = createTurnLimiter(
      stopSequences,
      tokenBudget === null ? null : tokenBudget * CHARS_PER_TOKEN_ESTIMATE,
    );
    const capturedEvents: NormalizedConversationEvent[] = [];
    const messages = normalized(body.messages);
    if (messages.some((message) => message.role === "tool")) {
      return reply.code(400).send({
        error: {
          message:
            "Tool messages are not supported by Mirror's Chat Completions subset",
          type: "unsupported_parameter",
        },
      });
    }
    const last = messages.at(-1);
    if (!last || last.role !== "user")
      return reply.code(400).send({
        error: {
          message: "The final message must have role=user",
          type: "invalid_request_error",
        },
      });
    // Only the final turn can carry attachments - matches how ChatGPT's own
    // UI (and Mirror's /api/chat) treat attachments as belonging to the
    // message being sent right now, not to arbitrary history.
    const imageParts = imagePartsOf(body.messages.at(-1)?.content ?? null);
    if (!last.content.trim() && imageParts.length === 0) {
      // An empty final turn (e.g. a client that pre-appends a fresh blank
      // user row after each reply for convenience, then gets submitted
      // before anything is typed into it) would otherwise be forwarded to
      // ChatGPT as a genuinely content-free message - the GPT notices
      // nothing came through and replies saying so, and depending on the
      // client's own history bookkeeping that reply can end up rendered
      // back-to-back with the prior one, with no visible user text between.
      // An image-only turn (no text) is fine - it's how a client asks
      // "what's in this picture" - so the check only fires when there is
      // neither text nor an image attached.
      return reply.code(400).send({
        error: {
          message: "The final user message must not be empty",
          type: "invalid_request_error",
        },
      });
    }
    let resolvedAttachments: UploadedFile[] | undefined;
    if (imageParts.length) {
      try {
        const uploadClient = new ChatGptBackendClient(await getValidCredentials());
        resolvedAttachments = await Promise.all(
          imageParts.map((part, i) => resolveImageAttachment(uploadClient, part, i)),
        );
        const accountId = getSession()?.accountId ?? "default";
        for (const file of resolvedAttachments) saveFile(file, accountId);
      } catch (error) {
        return reply.code(400).send({
          error: {
            message: error instanceof Error ? error.message : "Could not process an image_url attachment",
            type: "invalid_request_error",
          },
        });
      }
    }

    // store:false means "one-shot": this call never continues (or is
    // continuable from) any thread, even if metadata.conversation_id is
    // supplied - it always gets its own throwaway conversation and never
    // returns x-mirror-conversation-id. See CompletionBody above.
    const oneShot = body.store === false;

    // metadata.conversation_id is optional (see CompletionBody above): if
    // present but doesn't exist yet, that's not an error - the caller is
    // picking their own id for a brand-new conversation, so we create one
    // using that id. It's only a conflict if the id is already taken by a
    // conversation on a different account. If absent entirely, resent
    // history alone can still land this on an existing conversation - see
    // findConversationByTranscript below.
    const explicitConversationId = !oneShot
      ? body.metadata?.conversation_id
      : undefined;
    // Same key a concurrent duplicate call (double-click, eager retry, etc)
    // for this exact conversation_id would compute, so they serialize
    // against each other rather than both reading the same "current head"
    // and branching off it at once (see withConversationLock above).
    const lockKey = explicitConversationId ?? null;
    const completionId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    req.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    if (body.stream) {
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders())) {
        if (value !== undefined) reply.raw.setHeader(name, value);
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      // `setNoDelay` disables Nagle's algorithm on a real TCP socket so
      // each small SSE chunk reaches the client immediately instead of
      // being batched - but not every transport a reply's raw socket can
      // be exposes it (Fastify's own test harness (light-my-request)
      // stands in a plain Writable with no such method; the same is true
      // of some HTTP/2 socket wrappers). Calling it unconditionally throws
      // synchronously *after* reply.hijack() has already taken the reply
      // out of Fastify's normal error handling, so nothing ever reaches
      // the try/catch below or calls reply.raw.end() - the request just
      // hangs forever from the caller's perspective. Guard it instead.
      if (typeof reply.raw.socket?.setNoDelay === "function")
        reply.raw.socket.setNoDelay(true);
      sse(reply, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      });
    }

    try {
      await withConversationLock(lockKey, async () => {
        assertSessionRevision(requestRevision);
        // Resolve state after acquiring the lock. Two concurrent calls using a
        // brand-new caller-selected id must not both decide to INSERT it.
        const accountId = getSession()?.accountId ?? "default";
        const explicitConversation = explicitConversationId
          ? getConversation(explicitConversationId)
          : null;
        if (
          explicitConversation &&
          explicitConversation.accountId !== accountId
        ) {
          throw Object.assign(
            new Error(
              `metadata.conversation_id is already in use: ${explicitConversationId}`,
            ),
            { statusCode: 400 },
          );
        }
        const newConversationId =
          explicitConversationId && !explicitConversation
            ? explicitConversationId
            : undefined;
        const route = routeModel(body.model, body.metadata);

        // priorTranscript is everything the caller sent *except* the new
        // final user turn - i.e. what they believe the conversation's
        // history already is. We compare/match against this, not the full
        // `messages` array, since the new turn obviously never matches
        // anything yet.
        const priorTranscript = messages.slice(0, -1);
        const priorTranscriptHash = priorTranscript.length
          ? fingerprintValue(priorTranscript)
          : null;

        // No metadata.conversation_id at all: try to recognize this as a
        // continuation purely from the resent history, for clients that
        // manage their own history and never track a conversation id (see
        // CompletionBody's metadata doc-comment above).
        let inferredConversation: StoredConversation | null = null;
        if (!oneShot && !explicitConversationId && priorTranscriptHash) {
          const candidate = findConversationByTranscript(
            accountId,
            priorTranscriptHash,
          );
          if (
            candidate &&
            (route.gizmoId === undefined ||
              route.gizmoId === candidate.gizmoId) &&
            (!route.model ||
              route.model === "auto" ||
              route.model === candidate.model) &&
            (route.private === undefined ||
              route.private === Boolean(candidate.private))
          ) {
            inferredConversation = candidate;
          }
        }

        const activeConversation = explicitConversation ?? inferredConversation;

        // An explicit conversation_id whose resent prior transcript no
        // longer matches what we have on record means the caller edited an
        // earlier turn rather than merely appending one. User-turn edits can
        // rebase; assistant-turn edits are rejected below.
        const storedTranscriptHash = explicitConversation
          ? getOpenAiTranscript(explicitConversation.id)
          : null;
        const priorConversationMessages = conversationalMessages(priorTranscript);
        const storedMessageRows = explicitConversation
          ? listMessages(explicitConversation.id)
          : [];
        const storedConversationMessages = storedMessageRows.map(
          ({ role, content }) => ({
              role,
              content,
            }),
        );
        const historyDifferenceIndex = firstHistoryDifference(
          storedConversationMessages,
          priorConversationMessages,
        );
        if (
          explicitConversation &&
          storedConversationMessages[historyDifferenceIndex]?.role ===
            "assistant"
        ) {
          throw Object.assign(
            new Error(
              "Assistant messages are read-only and cannot be changed or removed while continuing a Mirror conversation.",
            ),
            { statusCode: 400 },
          );
        }
        // Conversations created/imported before transcript fingerprints were
        // introduced still need safe edit detection. Their local logical
        // user/assistant rows are the best available baseline. The context
        // hash covers system/developer changes for older OpenAI-created rows;
        // imported ChatGPT conversations have no corresponding system row, so
        // their first unchanged Playground continuation remains possible.
        const legacyTranscriptChanged = Boolean(
          explicitConversation &&
            !storedTranscriptHash &&
            priorTranscriptHash &&
            storedConversationMessages.length > 0 &&
            fingerprintValue(storedConversationMessages) !==
              fingerprintValue(priorConversationMessages),
        );
        const storedContextHash = explicitConversation
          ? getOpenAiContext(explicitConversation.id)
          : null;
        const legacyContextChanged = Boolean(
          !storedTranscriptHash &&
            storedContextHash &&
            storedContextHash !== instructionsHash(messages),
        );
        const needsRebase = Boolean(
          explicitConversation &&
            priorTranscriptHash &&
            ((storedTranscriptHash &&
              storedTranscriptHash !== priorTranscriptHash) ||
              legacyTranscriptChanged ||
              legacyContextChanged),
        );
        const isUserHistoryEdit = Boolean(
          needsRebase &&
            storedConversationMessages[historyDifferenceIndex]?.role === "user",
        );
        const rebasePriorMessages = priorConversationMessages.map(
          (message, index) => {
            const stored = storedMessageRows[index];
            return stored &&
              stored.role === message.role &&
              stored.content === message.content
              ? {
                  ...message,
                  id: stored.id,
                  upstreamNodeId: stored.upstreamNodeId,
                  status: stored.status,
                  events: stored.events,
                  attachments: stored.attachments,
                }
              : message;
          },
        );

        if (explicitConversation && !needsRebase) {
          if (
            route.gizmoId !== undefined &&
            route.gizmoId !== explicitConversation.gizmoId
          ) {
            throw Object.assign(
              new Error(
                "The GPT/Project cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
          if (
            route.model &&
            route.model !== "auto" &&
            route.model !== explicitConversation.model
          ) {
            throw Object.assign(
              new Error(
                "The model cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
          if (
            route.private !== undefined &&
            route.private !== Boolean(explicitConversation.private)
          ) {
            throw Object.assign(
              new Error(
                "Private-chat mode cannot change while continuing a Mirror conversation; start a new conversation id.",
              ),
              { statusCode: 400 },
            );
          }
        }

        if (needsRebase) {
          rebaseConversationUpstream(explicitConversation!.id, {
            model: route.model,
            gizmoId: route.gizmoId,
            private: route.private,
            currentNodeId: isUserHistoryEdit
              ? (storedMessageRows[historyDifferenceIndex - 1]
                  ?.upstreamNodeId ?? "client-created-root")
              : "client-created-root",
          });
          replaceMessages(explicitConversation!.id, rebasePriorMessages);
        }

        // A user edit is a real ChatGPT conversation-tree branch: send only
        // the edited final user turn under its actual predecessor. Other
        // rebases (for example changed system instructions) still need the
        // synthetic full-context prompt because those instructions are not
        // materialized as editable upstream message nodes.
        const continuing =
          Boolean(activeConversation?.conversationId) &&
          (!needsRebase || isUserHistoryEdit);
        let chat: Awaited<ReturnType<typeof runChat>>;
        try {
          chat = await runChat({
            conversationId: activeConversation?.id,
            newConversationId,
            prompt: promptFor(messages, continuing),
            model: route.model,
            gizmoId: route.gizmoId,
            private: route.private || oneShot,
            ephemeral: oneShot,
            attachments: resolvedAttachments,
            signal: controller.signal,
            onDelta: body.stream
              ? (delta, full) => {
                  const safe = limiter.feed(delta, full);
                  if (!safe) return;
                  sse(reply, {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: safe },
                        finish_reason: null,
                      },
                    ],
                  });
                }
              : undefined,
            onEvent: (event) => capturedEvents.push(event),
          });
        } catch (error) {
          // runChat necessarily records the synthetic replay prompt (and an
          // error/partial assistant row) before contacting upstream. On a
          // failed rebase those implementation-detail rows must not leak into
          // the editor's canonical history; the client never appended the
          // failed turn either, so restore exactly the edited prior prefix.
          if (needsRebase) {
            replaceMessages(explicitConversation!.id, rebasePriorMessages);
          }
          throw error;
        }
        const { conversation, result, storedAssistantMessageId } = chat;
        if (!oneShot) {
          if (!continuing) {
            // A first/rebased upstream turn is sent as one synthetic prompt
            // containing the whole OpenAI transcript. That prompt is a wire
            // implementation detail, not a logical user message. Rewrite the
            // local rows to the exact user/assistant transcript the caller
            // owns, while retaining the real new user/assistant node ids and
            // assistant events from runChat. Otherwise loading the chat would
            // expose a duplicate flattened transcript, and its next request
            // would immediately fail transcript matching and rebase again.
            const stored = listMessages(conversation.id);
            const storedUser = stored.find(
              (message) => message.upstreamNodeId === result.userMessageId,
            );
            const storedAssistant = stored.find(
              (message) => message.id === storedAssistantMessageId,
            );
            const canonical = conversationalMessages(messages);
            const lastUserIndex = canonical.findLastIndex(
              (message) => message.role === "user",
            );
            replaceMessages(conversation.id, [
              ...canonical.map((message, index) =>
                index === lastUserIndex && storedUser
                  ? {
                      ...message,
                      id: storedUser.id,
                      upstreamNodeId: storedUser.upstreamNodeId,
                      status: storedUser.status,
                      events: storedUser.events,
                      attachments: storedUser.attachments,
                    }
                  : message,
              ),
              {
                role: "assistant",
                content: result.text,
                ...(storedAssistant
                  ? {
                      id: storedAssistant.id,
                      upstreamNodeId: storedAssistant.upstreamNodeId,
                      status: storedAssistant.status,
                      events: storedAssistant.events,
                      attachments: storedAssistant.attachments,
                    }
                  : {}),
              },
            ]);
          }
          saveInstructions(conversation.id, messages);
          saveOpenAiContext(conversation.id, instructionsHash(messages));
          saveOpenAiTranscript(
            conversation.id,
            accountId,
            fingerprintValue([
              ...messages,
              { role: "assistant", content: result.text },
            ]),
          );
        }

        const { finishReason } = limiter.finalize(result.text);
        const responseMetadata = buildResponseMetadata(capturedEvents, conversation.conversationId);

        if (body.stream) {
          // Not part of the OpenAI chunk schema: an SSE comment line (ignored
          // by any spec-compliant SSE parser) carrying the Mirror conversation
          // id, since HTTP response headers can no longer be set once the
          // stream has started and this may be a brand-new conversation whose
          // id was not known until runChat() returned.
          if (!oneShot)
            reply.raw.write(`: mirror-conversation-id ${conversation.id}\n\n`);
          sse(reply, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: conversation.model,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            ...(responseMetadata ? { metadata: responseMetadata } : {}),
          });
          sse(reply, "[DONE]");
          reply.raw.end();
          return;
        }
        if (!oneShot) reply.header("x-mirror-conversation-id", conversation.id);
        return reply.send({
          id: completionId,
          object: "chat.completion",
          created,
          model: conversation.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: limiter.finalize(result.text).text },
              finish_reason: finishReason,
            },
          ],
          usage: null,
          ...(responseMetadata ? { metadata: responseMetadata } : {}),
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (body.stream) {
        sse(reply, { error: { message, type: "mirror_error" } });
        sse(reply, "[DONE]");
        reply.raw.end();
        return;
      }
      const status = Number(
        (error as { statusCode?: number }).statusCode ?? 502,
      );
      return reply.code(status).send({
        error: {
          message,
          type: status === 400 ? "invalid_request_error" : "mirror_error",
        },
      });
    }
  });
}
