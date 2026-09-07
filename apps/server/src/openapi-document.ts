import "./zod-openapi-init.js";
import { createDocument, type oas31, type ZodOpenApiPathsObject } from "zod-openapi";
import { z } from "zod";
import { CompletionBody } from "./openai.js";
import {
  SetSessionBody,
  ConversationIdParam,
  ModelUpdateBody,
  BranchBody,
  NewConversationBody,
  ConversationsQuery,
  AssetsQuery,
  ChatBody,
} from "./api-schemas.js";

/**
 * This document is generated, not hand-maintained: every schema below - path
 * params, query strings, request bodies, AND response bodies - is a Zod
 * schema modeled directly on the TypeScript types the corresponding route
 * actually produces or validates against (StoredConversation/StoredMessage
 * in store.ts, UploadedFile/ModelDescriptor/GizmoSummary/
 * NormalizedConversationEvent in @mirror/protocol, EgressStatus in
 * egress.ts, and CompletionBody/the request schemas in api-schemas.ts for
 * everything that IS runtime-validated). Whenever one of those shapes
 * changes, this file's schema should change with it in the same commit -
 * there is no separate JSON spec to remember to update by hand. Request-side
 * schemas double as the actual runtime validators (imported straight from
 * api-schemas.ts / openai.ts); response-side schemas here are the response
 * shapes' one authoritative description, since the route handlers build
 * those objects as plain literals with no schema of their own to import.
 */

const ErrorResponse = z
  .object({
    error: z.union([
      z.string(),
      z.object({ message: z.string(), type: z.string() }),
    ]),
  })
  .openapi({ ref: "Error", description: "Error envelope returned by Mirror's error handler." });

const OkResponse = z
  .object({ ok: z.boolean() })
  .openapi({ ref: "OkResponse" });

// --- /v1 (OpenAI-compatible) response schemas -----------------------------

const ModelSchema = z
  .object({
    id: z.string().openapi({ example: "gpt-4o" }),
    object: z.literal("model"),
    created: z.number().int(),
    owned_by: z.string(),
  })
  .openapi({
    ref: "Model",
    description:
      "An OpenAI-shaped model entry. Mirror lists both real ChatGPT model slugs (gpt-4o, " +
      "o1, ...) and Custom GPT / Project pseudo-models (ids like g-<hex> / g-p-<hex>) - " +
      "see COMPATIBILITY.md.",
  });

const ModelsResponse = z
  .object({
    object: z.literal("list"),
    data: z.array(ModelSchema),
  })
  .openapi({ ref: "ModelsResponse" });

const ChatMessageResponse = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.string().nullable(),
  })
  .openapi({ ref: "ChatMessageResponse" });

const CompletionResponseMetadata = z
  .object({
    mirror_tool_events: z.string().optional().openapi({
      description:
        "JSON-stringified array of {name, status} objects, one per ChatGPT built-in tool " +
        "invocation observed during the turn (web browsing, the code-interpreter sandbox, " +
        "etc). Parse with JSON.parse.",
    }),
    mirror_images: z.string().optional().openapi({
      description:
        "JSON-stringified array of {url} objects for any in-chat DALL-E image(s) ChatGPT " +
        "generated during the turn (distinct from the official /v1/images/generations " +
        "endpoint, which Mirror doesn't implement - see COMPATIBILITY.md). Each url " +
        "resolves against Mirror's GET /api/assets.",
    }),
  })
  .openapi({
    ref: "CompletionResponseMetadata",
    description:
      "Response-only convention: Mirror attaches ChatGPT-only, no-official-schema-slot " +
      "information here rather than inventing new top-level response fields the official " +
      "OpenAI client libraries wouldn't expect. Only present when there is something to " +
      "report. See COMPATIBILITY.md.",
  });

const CompletionResponse = z
  .object({
    id: z.string(),
    object: z.literal("chat.completion"),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        message: ChatMessageResponse,
        finish_reason: z.literal("stop").openapi({
          description:
            "Mirror reports stop on successful completion and never truncates responses based on token limits or stop strings.",
        }),
      }),
    ),
    usage: z.null().openapi({
      description:
        "Always null. backend-api reports no token counts anywhere - ChatGPT bills by plan " +
        "usage windows, not per-token metering - so there is nothing real to put here. See " +
        "COMPATIBILITY.md.",
    }),
    metadata: CompletionResponseMetadata.optional(),
  })
  .openapi({ ref: "CompletionResponse" });

// --- Shared building blocks, modeled on @mirror/protocol's types.ts -------

/**
 * Mirrors @mirror/protocol's NormalizedConversationEvent discriminated
 * union exactly (packages/protocol/src/types.ts) - the shape the SSE
 * reducer (sse.ts) produces from ChatGPT's raw event stream, and what
 * gets persisted alongside each stored message and surfaced through
 * GET /api/conversations/{id}.
 */
// Each variant gets its own `ref` (rather than staying an anonymous inline
// object) so it's hoisted into components.schemas as a named type -
// generators for statically-typed clients (e.g. Rust's progenitor / OpenAPI
// Generator) turn each ref into a real named struct instead of an anonymous
// one, and it lets buildOpenApiDocument() attach a proper OAS discriminator
// (see below) mapping "kind" values to these exact component names.
const AssistantTextEvent = z
  .object({
    kind: z.literal("assistant_text"),
    messageId: z.string().nullable(),
    delta: z.string().openapi({ description: "The text added by this SSE event alone." }),
    text: z.string().openapi({ description: "The full assistant text accumulated so far, including this delta." }),
  })
  .openapi({ ref: "AssistantTextEvent" });

const MessageEvent = z
  .object({
    kind: z.literal("message"),
    messageId: z.string().nullable(),
    role: z.string().nullable(),
    contentType: z.string().nullable(),
    authorName: z.string().nullable(),
    raw: z.record(z.unknown()).openapi({ description: "The raw upstream message envelope." }),
  })
  .openapi({ ref: "MessageEvent" });

const ToolEvent = z
  .object({
    kind: z.literal("tool"),
    messageId: z.string().nullable(),
    name: z.string().openapi({ description: "The built-in ChatGPT tool's name, e.g. web, python, dalle." }),
    status: z.string().nullable().optional().openapi({ description: "e.g. \"in_progress\", \"completed\", when backend-api reports one." }),
    raw: z.record(z.unknown()).openapi({ description: "The raw upstream tool-call envelope." }),
  })
  .openapi({
    ref: "ToolEvent",
    description: "A ChatGPT built-in tool invocation (web browsing, code interpreter, etc) - see COMPATIBILITY.md.",
  });

const CitationEvent = z
  .object({
    kind: z.literal("citation"),
    fileId: z.string().optional(),
    title: z.string().optional(),
    raw: z.unknown().openapi({ description: "The raw upstream citation envelope; shape varies by citation type." }),
  })
  .openapi({ ref: "CitationEvent" });

const ImageEvent = z
  .object({
    kind: z.literal("image"),
    assetPointer: z.string().openapi({ description: "Resolve via GET /api/assets?pointer=..." }),
    raw: z.unknown().openapi({ description: "The raw upstream image-generation envelope." }),
  })
  .openapi({
    ref: "ImageEvent",
    description: "An in-chat DALL-E generated image - see COMPATIBILITY.md.",
  });

const FileEvent = z
  .object({
    kind: z.literal("file"),
    assetPointer: z.string().openapi({ description: "Resolve via GET /api/assets?pointer=..." }),
    title: z.string().optional(),
    raw: z.unknown().openapi({ description: "The raw upstream file envelope." }),
  })
  .openapi({ ref: "FileEvent" });

const MarkerEvent = z
  .object({
    kind: z.literal("marker"),
    messageId: z.string().nullable(),
    marker: z.string().optional(),
    event: z.string().optional(),
    raw: z.record(z.unknown()).openapi({ description: "The raw upstream marker/event envelope." }),
  })
  .openapi({ ref: "MarkerEvent" });

const StatusEvent = z
  .object({
    kind: z.literal("status"),
    messageId: z.string().nullable(),
    status: z.string(),
  })
  .openapi({ ref: "StatusEvent" });

const RawEvent = z
  .object({
    kind: z.literal("raw"),
    raw: z.unknown().openapi({ description: "An unrecognized upstream SSE payload, passed through unparsed." }),
  })
  .openapi({ ref: "RawEvent" });

/**
 * Mirrors @mirror/protocol's NormalizedConversationEvent discriminated
 * union exactly (packages/protocol/src/types.ts) - the shape the SSE
 * reducer (sse.ts) produces from ChatGPT's raw event stream, and what
 * gets persisted alongside each stored message and surfaced through
 * GET /api/conversations/{id}. 'tool', 'image', and 'file' events are the
 * ones with no official OpenAI Chat Completions equivalent - see
 * COMPATIBILITY.md. buildOpenApiDocument() attaches this union's OAS
 * `discriminator` after zod-openapi builds the document (see below), so
 * generators for statically-typed clients can emit a real tagged enum
 * instead of a plain oneOf.
 */
const NormalizedConversationEvent = z
  .discriminatedUnion("kind", [
    AssistantTextEvent,
    MessageEvent,
    ToolEvent,
    CitationEvent,
    ImageEvent,
    FileEvent,
    MarkerEvent,
    StatusEvent,
    RawEvent,
  ])
  .openapi({ ref: "NormalizedConversationEvent" });

/** Mirrors UploadedFile from @mirror/protocol, minus the `raw` field Mirror strips before returning it publicly. */
const PublicUploadedFile = z
  .object({
    fileId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    useCase: z.enum(["multimodal", "my_files"]).openapi({
      description: "multimodal for images passed to the vision model; my_files for anything else (code interpreter, retrieval, etc).",
    }),
    width: z.number().optional().openapi({ description: "Present for image uploads." }),
    height: z.number().optional().openapi({ description: "Present for image uploads." }),
  })
  .openapi({
    ref: "UploadedFile",
    description: "A file uploaded to ChatGPT's file service via POST /api/files, with the raw upstream response stripped.",
  });

/** Mirrors StoredMessage from store.ts. */
const StoredMessage = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string(),
    upstreamNodeId: z.string().nullable().openapi({ description: "The backend-api message node id, or null if this turn never reached upstream." }),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    status: z.string().openapi({ description: "e.g. \"finished_successfully\", \"in_progress\" - passed through from backend-api." }),
    events: z.array(NormalizedConversationEvent),
    attachments: z.array(PublicUploadedFile).optional(),
    createdAt: z.string().datetime().openapi({ description: "ISO 8601 timestamp." }),
  })
  .openapi({ ref: "StoredMessage", description: "A single stored message in a Mirror conversation (store.ts)." });

/**
 * Mirrors StoredConversation from store.ts (which extends
 * ConversationSessionState from @mirror/protocol's types.ts).
 */
const StoredConversation = z
  .object({
    id: z.string().openapi({ description: "The Mirror-local conversation id (UUID when auto-generated, or a caller-supplied slug via metadata.conversation_id)." }),
    accountId: z.string(),
    title: z.string(),
    init: z.record(z.unknown()).nullable().openapi({ description: "Raw backend-api f/conversation/init response, once this conversation has been initialized." }),
    createdAt: z.string().datetime().openapi({ description: "ISO 8601 timestamp." }),
    updatedAt: z.string().datetime().openapi({ description: "ISO 8601 timestamp." }),
    isBranch: z.boolean().openapi({ description: "True if this conversation was created via POST /api/conversations/{id}/branch." }),
    conversationId: z.string().nullable().openapi({ description: "The real upstream backend-api conversation id, or null until the first turn is sent." }),
    currentNodeId: z.string().openapi({ description: "The assistant node that becomes parent_message_id on the next turn." }),
    model: z.string(),
    gizmoId: z.string().nullable().optional().openapi({ description: "Set when this conversation is pinned to a Custom GPT or Project." }),
    initialized: z.boolean().optional(),
    private: z.boolean().optional().openapi({ description: "Temporary/incognito chat: excluded from chatgpt.com history and model training." }),
  })
  .openapi({ ref: "StoredConversation", description: "A Mirror-local conversation record (store.ts)." });

/** Mirrors ModelDescriptor from @mirror/protocol, minus the `raw` field GET /api/models strips before returning it. */
const PublicModelDescriptor = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    maxTokens: z.number().optional(),
    capabilities: z.unknown().optional(),
    enabledTools: z.unknown().optional(),
  })
  .openapi({
    ref: "PublicModelDescriptor",
    description: "Mirror's native model shape (normalizeModels() in @mirror/protocol), with the raw upstream payload stripped.",
  });

/** Mirrors GizmoSummary from @mirror/protocol, minus the `raw` field GET /api/gpts strips before returning it. */
const PublicGizmoSummary = z
  .object({
    id: z.string().openapi({ description: "g-<hex> for a Custom GPT, g-p-<hex> for a Project." }),
    shortUrl: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    iconUrl: z.string().optional(),
    filesCount: z.number().optional(),
  })
  .openapi({
    ref: "PublicGizmoSummary",
    description: "Mirror's native Custom GPT / Project shape (normalizeGizmos() in @mirror/protocol), with the raw upstream payload stripped.",
  });

/** Mirrors EgressStatus from egress.ts. */
const EgressStatus = z
  .object({
    mode: z.enum(["direct", "warp"]),
    required: z.boolean().openapi({ description: "Whether this deployment is configured to require verified WARP egress before it will serve traffic." }),
    verified: z.boolean(),
    checkedAt: z.string().datetime().nullable(),
    error: z.string().nullable(),
  })
  .openapi({ ref: "EgressStatus", description: "The result of Mirror's last Cloudflare WARP verification check (egress.ts)." });

/** The shape stored/returned by store.ts's getInstructions(). */
const InstructionMessage = z
  .object({ role: z.string(), content: z.string() })
  .openapi({ ref: "InstructionMessage" });

const nativeApiPaths: ZodOpenApiPathsObject = {
  "/api/health": {
    get: {
      summary: "Health check",
      tags: ["Mirror"],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean().openapi({ description: "True only when storage is healthy and required WARP egress (if configured) is verified." }),
                storage: z.literal("sqlite"),
                configured: z.boolean().openapi({ description: "Whether a ChatGPT session has been connected." }),
                egress: EgressStatus,
              }),
            },
          },
        },
      },
    },
  },
  "/api/session": {
    get: {
      summary: "Check whether a ChatGPT session is configured",
      tags: ["Mirror"],
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                configured: z.boolean(),
                savedAt: z.number().nullable().openapi({ description: "Unix ms timestamp the session was last saved, or null if none is configured." }),
              }),
            },
          },
        },
      },
    },
    post: {
      summary: "Connect Mirror to a ChatGPT account",
      tags: ["Mirror"],
      requestBody: { content: { "application/json": { schema: SetSessionBody } } },
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                ok: z.literal(true),
                accountId: z.string().optional().openapi({ description: "The ChatGPT account id, when the upstream account lookup succeeded." }),
                email: z.string().nullable().openapi({ description: "The account's email, when ChatGPT's /me endpoint returned one." }),
              }),
            },
          },
        },
        "400": {
          description: "Invalid session token",
          content: { "application/json": { schema: ErrorResponse } },
        },
      },
    },
    delete: {
      summary: "Disconnect the configured ChatGPT session",
      tags: ["Mirror"],
      responses: { "200": { description: "OK", content: { "application/json": { schema: OkResponse } } } },
    },
  },
  "/api/models": {
    get: {
      summary: "List models (Mirror's native shape, includes richer fields than /v1/models but no raw upstream payload)",
      tags: ["Mirror"],
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: z.array(PublicModelDescriptor) } },
        },
      },
    },
  },
  "/api/gpts": {
    get: {
      summary: "List Custom GPTs and Projects visible to this account",
      tags: ["Mirror"],
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: z.array(PublicGizmoSummary) } },
        },
      },
    },
  },
  "/api/conversations": {
    get: {
      summary: "List locally-known conversations, paginated",
      tags: ["Mirror"],
      requestParams: { query: ConversationsQuery },
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                items: z.array(StoredConversation),
                total: z.number().int().openapi({ description: "Total conversation count for this account, independent of limit/offset." }),
                hasMore: z.boolean(),
              }),
            },
          },
        },
      },
    },
    post: {
      summary: "Create a new empty conversation",
      tags: ["Mirror"],
      requestBody: { content: { "application/json": { schema: NewConversationBody } } },
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: StoredConversation } } },
      },
    },
  },
  "/api/conversations/{id}": {
    get: {
      summary: "Fetch a conversation and its messages",
      tags: ["Mirror"],
      requestParams: { path: ConversationIdParam },
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({
                conversation: StoredConversation,
                messages: z.array(StoredMessage),
                instructions: z.array(InstructionMessage).openapi({
                  description: "Combined system/developer instructions synthesized for this conversation - see promptFor() in openai.ts.",
                }),
              }),
            },
          },
        },
        "404": { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
    patch: {
      summary: "Change a conversation's model",
      tags: ["Mirror"],
      requestParams: { path: ConversationIdParam },
      requestBody: { content: { "application/json": { schema: ModelUpdateBody } } },
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: StoredConversation.nullable() } } },
        "404": { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
    delete: {
      summary: "Delete a conversation",
      tags: ["Mirror"],
      requestParams: { path: ConversationIdParam },
      responses: { "200": { description: "OK", content: { "application/json": { schema: OkResponse } } } },
    },
  },
  "/api/conversations/{id}/stop": {
    post: {
      summary: "Stop an in-flight generation",
      tags: ["Mirror"],
      requestParams: { path: ConversationIdParam },
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean().openapi({ description: "False if no generation was in flight for this conversation." }) }),
            },
          },
        },
        "404": { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/conversations/{id}/branch": {
    post: {
      summary: "Fork a new branch from an existing message",
      tags: ["Mirror"],
      requestParams: { path: ConversationIdParam },
      requestBody: { content: { "application/json": { schema: BranchBody } } },
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: StoredConversation.nullable() } },
        },
        "400": {
          description: "Invalid branch point",
          content: { "application/json": { schema: ErrorResponse } },
        },
        "404": { description: "Not found", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/files": {
    post: {
      summary: "Upload a file attachment (multipart/form-data)",
      tags: ["Mirror"],
      requestBody: {
        content: {
          "multipart/form-data": {
            schema: z
              .object({
                file: z.string().openapi({
                  type: "string",
                  format: "binary",
                  description: "A single file field, handled by @fastify/multipart. Exactly one file per request.",
                }),
              })
              .openapi({ description: "A single-file multipart/form-data upload." }),
          },
        },
      },
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: PublicUploadedFile } } },
        "400": { description: "No file uploaded", content: { "application/json": { schema: ErrorResponse } } },
      },
    },
  },
  "/api/assets": {
    get: {
      summary: "Resolve a file-service:// or sediment:// asset pointer to a downloadable URL",
      tags: ["Mirror"],
      requestParams: { query: AssetsQuery },
      responses: {
        "302": { description: "Redirect to the resolved, time-limited asset URL." },
        "400": {
          description: "Unsupported pointer",
          content: { "application/json": { schema: ErrorResponse } },
        },
        "404": {
          description: "Not found / not owned by this account",
          content: { "application/json": { schema: ErrorResponse } },
        },
      },
    },
  },
  "/api/chat": {
    post: {
      summary:
        "Mirror's native streaming chat endpoint (text/event-stream), used by the proxied " +
        "ChatGPT UI and Playground",
      description:
        "A text/event-stream of named SSE events: `delta` ({delta: string}) for each streamed " +
        "text chunk, `event` for a NormalizedConversationEvent (tool/citation/image/file/marker/" +
        "status only - assistant_text/message/raw are filtered out, see publicEvent() in " +
        "index.ts), `done` (the final result) once the turn completes, or `error` ({message}) " +
        "if generation fails or is stopped.",
      tags: ["Mirror"],
      requestBody: { content: { "application/json": { schema: ChatBody } } },
      responses: {
        "200": {
          description: "text/event-stream of delta/event/done/error events - see the operation description.",
          content: { "text/event-stream": { schema: z.string() } },
        },
      },
    },
  },
  "/mirror/openapi": {
    get: {
      summary: "This OpenAPI document",
      tags: ["Mirror"],
      requestParams: {
        query: z.object({
          format: z.enum(["json", "yaml"]).default("json").openapi({
            description: "?format=yaml returns YAML instead of the default JSON.",
          }),
        }),
      },
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": { schema: z.object({}).passthrough().openapi({ description: "This same OpenAPI 3.1 document, as JSON." }) },
            "application/yaml": { schema: z.string().openapi({ description: "This same OpenAPI 3.1 document, as YAML." }) },
          },
        },
      },
    },
  },
};

/**
 * zod-openapi doesn't emit an OAS `discriminator` object for a
 * z.discriminatedUnion() - it only emits `oneOf` with a `const` tag per
 * branch (valid OAS 3.1 / JSON Schema on its own). That's enough for
 * loosely-typed consumers, but a generator producing a real tagged enum
 * for a statically-typed client (e.g. Rust's progenitor or OpenAPI
 * Generator) does a much better job when `discriminator.propertyName` and
 * `discriminator.mapping` are present, so it can pick the right variant by
 * tag instead of trying every branch. This patches that one discriminator
 * in after the fact, mapping each `kind` value to the named component ref
 * that variant was given above (AssistantTextEvent, ToolEvent, ...).
 */
function withDiscriminators(doc: oas31.OpenAPIObject): oas31.OpenAPIObject {
  const target = doc.components?.schemas?.NormalizedConversationEvent as
    | (oas31.SchemaObject & { oneOf?: oas31.ReferenceObject[] })
    | undefined;
  if (!target?.oneOf) return doc;
  const kindToRef: Record<string, string> = {
    assistant_text: "AssistantTextEvent",
    message: "MessageEvent",
    tool: "ToolEvent",
    citation: "CitationEvent",
    image: "ImageEvent",
    file: "FileEvent",
    marker: "MarkerEvent",
    status: "StatusEvent",
    raw: "RawEvent",
  };
  target.oneOf = Object.values(kindToRef).map((ref) => ({ $ref: `#/components/schemas/${ref}` }));
  target.discriminator = {
    propertyName: "kind",
    mapping: Object.fromEntries(
      Object.entries(kindToRef).map(([kind, ref]) => [kind, `#/components/schemas/${ref}`]),
    ),
  };
  return doc;
}

export function buildOpenApiDocument(): oas31.OpenAPIObject {
  return withDiscriminators(createDocument({
    openapi: "3.1.0",
    info: {
      title: "Mirror API",
      version: "0.1.0",
      description:
        "Mirror exposes two API surfaces on top of a single ChatGPT account: an OpenAI-" +
        "compatible surface under /v1 (for use with any OpenAI SDK or tool), and Mirror's " +
        "own /api surface (used by the proxied ChatGPT UI and the Playground). See " +
        "README.md for setup and COMPATIBILITY.md for exactly where the /v1 surface does " +
        "and doesn't match the real OpenAI API. This document, request schemas included, " +
        "is generated from the Zod schemas the server validates requests against and the " +
        "TypeScript types its routes return (see openapi-document.ts).",
    },
    servers: [{ url: "/", description: "This Mirror instance" }],
    security: [{ mirrorApiKey: [] }],
    components: {
      securitySchemes: {
        mirrorApiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A value from MIRROR_API_KEY / MIRROR_API_KEYS. Required for /v1/* and /api/* " +
            "requests that aren't coming from a browser tab that has already completed the " +
            "Mirror controls sessionToken bootstrap (which instead authenticates via an " +
            "HttpOnly mirror_control cookie).",
        },
      },
    },
    paths: {
      "/v1/models": {
        get: {
          summary: "List available models",
          description:
            "Real ChatGPT model slugs plus Custom GPT / Project pseudo-models the account " +
            "can chat with.",
          tags: ["OpenAI-compatible"],
          responses: {
            "200": { description: "OK", content: { "application/json": { schema: ModelsResponse } } },
            "401": {
              description: "Missing/invalid Mirror API key",
              content: { "application/json": { schema: ErrorResponse } },
            },
          },
        },
      },
      "/v1/chat/completions": {
        post: {
          summary: "Create a chat completion",
          description:
            "OpenAI Chat Completions-shaped endpoint backed by chatgpt.com/backend-api. See " +
            "COMPATIBILITY.md for the full list of what is and isn't supported relative to " +
            "the official API.",
          tags: ["OpenAI-compatible"],
          requestBody: {
            content: { "application/json": { schema: CompletionBody } },
          },
          responses: {
            "200": {
              description:
                "OK. When stream=true this is a text/event-stream of OpenAI-shaped " +
                "chat.completion.chunk SSE events instead of a single JSON body.",
              content: {
                "application/json": { schema: CompletionResponse },
                "text/event-stream": { schema: z.string() },
              },
            },
            "400": {
              description: "Invalid or unsupported request field",
              content: { "application/json": { schema: ErrorResponse } },
            },
            "401": {
              description: "Missing/invalid Mirror API key",
              content: { "application/json": { schema: ErrorResponse } },
            },
          },
        },
      },
      ...nativeApiPaths,
    },
  }));
}
