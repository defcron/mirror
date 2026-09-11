import "./zod-openapi-init.js";
import { z } from "zod";

/**
 * Request-shape schemas for Mirror's native /api/* routes, shared between
 * index.ts (which validates against them at runtime) and
 * openapi-document.ts (which derives the generated OpenAPI document from
 * these same schemas). Splitting them out into their own module - rather
 * than defining them inline in index.ts, or letting openapi-document.ts
 * import them straight from index.ts - avoids a circular import between
 * index.ts and openapi-document.ts (index.ts already imports
 * buildOpenApiDocument from there to serve /mirror/openapi).
 */

export const SetSessionBody = z
  .object({
    sessionToken: z
      .string()
      .min(20, "That doesn't look like a valid session token")
      .openapi({
        description:
          "The value of the __Secure-next-auth.session-token cookie from chatgpt.com/api/auth/session.",
      }),
    turnstileToken: z
      .string()
      .optional()
      .openapi({
        description:
          "Optional Cloudflare Turnstile token for sentinel requirements.",
      }),
  })
  .openapi({ ref: "SetSessionBody" });

// Mirror conversation ids are UUIDs when auto-generated, but a caller can
// also name their own via /v1/chat/completions' metadata.conversation_id
// (e.g. an arbitrary slug) - accept any non-empty id here so a
// Playground/API-driven conversation created that way can still be
// browsed, loaded, and managed through these routes.
export const ConversationIdParam = z
  .object({
    id: z.string().min(1).openapi({ description: "A Mirror conversation id (UUID or a caller-supplied slug)." }),
  })
  .openapi({ ref: "ConversationIdParam" });

export const ModelUpdateBody = z
  .object({ model: z.string().min(1) })
  .openapi({ ref: "ModelUpdateBody", description: "Change a conversation's model." });

export const BranchBody = z
  .object({
    messageId: z.string().uuid().openapi({ description: "The message id to branch from; must have an upstreamNodeId." }),
    title: z.string().optional(),
  })
  .openapi({ ref: "BranchBody" });

export const NewConversationBody = z
  .object({
    model: z.string().default("auto"),
    gizmoId: z.string().nullable().optional(),
  })
  .openapi({ ref: "NewConversationBody" });

const queryBoolean = z.enum(["true", "false"]).transform((value) => value === "true");
export const ConversationsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
    sync: queryBoolean.default("true").openapi({
      description: "Whether to sync this page against the real ChatGPT sidebar before reading the local mirror of it.",
      type: "string",
    }),
    // Restart the incremental sync cursor from the very top instead of
    // resuming where a previous call left off - only worth paying for on an
    // explicit user-initiated refresh (see App.tsx), not on every page load.
    resync: queryBoolean.default("false").openapi({
      description: "Restart the incremental sync cursor from the top instead of resuming where a previous call left off.",
      type: "string",
    }),
  })
  .openapi({ ref: "ConversationsQuery" });

export const AssetsQuery = z
  .object({
    pointer: z.string().openapi({ description: "A file-service:// or sediment:// asset pointer." }),
    upstreamConversationId: z.string().optional().openapi({
      description: "Required when pointer is a sediment:// pointer, to verify ownership of the source conversation.",
    }),
  })
  .openapi({ ref: "AssetsQuery" });


export const ChatAttachment = z
  .object({
    fileId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    useCase: z.enum(["multimodal", "my_files"]),
    width: z.number().optional(),
    height: z.number().optional(),
    raw: z.record(z.unknown()).default({}),
  })
  .openapi({ ref: "ChatAttachment", description: "A file previously uploaded via POST /api/files." });

export const ChatBody = z
  .object({
    prompt: z.string().min(1),
    model: z.string().default("auto"),
    conversationId: z.string().uuid().nullable().optional(),
    gizmoId: z.string().nullable().optional(),
    timezone: z.string().optional(),
    timezoneOffsetMin: z.number().optional(),
    attachments: z.array(ChatAttachment).default([]),
    turnstileToken: z.string().optional().openapi({
      description: "Optional Cloudflare Turnstile token override for sentinel requirements.",
    }),
  })
  .openapi({
    ref: "ChatBody",
    description: "Mirror's native chat request, used by the proxied ChatGPT UI and Playground (see POST /api/chat).",
  });

