import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CompletionBody } from "./openai.js";
import { getEgressStatus } from "./egress.js";
import { configuredApiKeys } from "./security.js";
import { recentFailures } from "./api-errors.js";
import { databaseHealthy, getSession, getConversation, getInstructions, listMessages, searchConversations, relatedConversations } from "./store.js";

export const SearchQuery = z.object({ q: z.string().trim().min(1).max(200) });
export const ExportQuery = z.object({
  format: z.enum(["json", "markdown"]).default("json"),
  attachments: z.enum(["true", "false"]).default("false"),
  metadata: z.enum(["true", "false"]).default("false"),
});
export const IdParams = z.object({ id: z.string().min(1).max(200) });

export function capabilities() {
  return {
    schemaVersion: 1,
    routes: ["GET /v1/models", "POST /v1/chat/completions", "GET /v1/capabilities"],
    fields: Object.keys(CompletionBody.shape),
    metadataFields: ["conversation_id", "mirror_model", "private"],
    approximations: ["stop", "max_tokens", "max_completion_tokens", "system/developer instructions"],
    unsupported: ["tools", "tool_choice", "response_format", "temperature", "top_p", "seed", "n", "audio", "work_mode"],
    usage: null,
    conversation: { minimalContinuation: true, fullHistory: true, assistantEditable: false, streamId: "SSE comment", jsonId: "x-mirror-conversation-id" },
  };
}

export async function registerInsightRoutes(app: FastifyInstance) {
  const account = () => getSession()?.accountId ?? "default";
  app.get("/v1/capabilities", async () => capabilities());
  app.get("/api/diagnostics", async () => {
    const egress = getEgressStatus();
    return {
      schemaVersion: 1,
      build: { version: "0.1.0", revision: /^[a-f0-9]{7,40}$/.test(process.env.MIRROR_BUILD_REVISION ?? "") ? process.env.MIRROR_BUILD_REVISION : "development" },
      api: { reachable: true, keyConfigured: configuredApiKeys().length > 0 },
      storage: { engine: "sqlite", healthy: databaseHealthy() },
      egress: { required: egress.required, verified: egress.verified, mode: egress.mode, checkedAt: egress.checkedAt },
      session: { saved: Boolean(getSession()), generationVerified: false },
      recentFailures: recentFailures(),
      nextAction: !egress.verified ? "Check the WARP container health." : !getSession() ? "Save a session in Mirror controls." : "Test model discovery, then explicitly run a generation in Playground.",
    };
  });
  app.get("/api/conversations/search", async req => ({ items: searchConversations(account(), SearchQuery.parse(req.query).q) }));
  app.get("/api/conversations/:id/branches", async (req, reply) => {
    const conversation = getConversation(IdParams.parse(req.params).id);
    if (conversation?.accountId !== account()) return reply.code(404).send({ error: "Conversation not found" });
    return { selected: conversation.id, parent: conversation.currentNodeId,
      items: conversation.conversationId ? relatedConversations(account(), conversation.conversationId) : [conversation],
      nodes: listMessages(conversation.id).map(({ id, upstreamNodeId, role, status }) => ({ id, upstreamNodeId, role, status })),
    };
  });
  app.get("/api/conversations/:id/export", async (req, reply) => {
    const conversation = getConversation(IdParams.parse(req.params).id);
    if (conversation?.accountId !== account()) return reply.code(404).send({ error: "Conversation not found" });
    const query = ExportQuery.parse(req.query);
    const messages = listMessages(conversation.id).map(message => ({ role: message.role, content: message.content,
      ...(query.metadata === "true" ? { status: message.status, createdAt: message.createdAt, upstreamNodeId: message.upstreamNodeId } : {}),
      // store.ts's attachments_json column is NOT NULL DEFAULT '[]', so
      // listMessages() always returns a real (possibly empty) array here -
      // the field is optional only in StoredMessage's input/write shape.
      ...(query.attachments === "true" ? { attachments: message.attachments!.map(file => ({ fileId: file.fileId, fileName: file.fileName, mimeType: file.mimeType })) } : {}),
    }));
    const exported = { schemaVersion: 1, kind: "mirror-transcript-archive", resumableImport: false,
      title: conversation.title, instructions: getInstructions(conversation.id), messages,
      ...(query.metadata === "true" ? { metadata: { mirrorId: conversation.id, upstreamId: conversation.conversationId, currentNodeId: conversation.currentNodeId, model: conversation.model } } : {}),
    };
    reply.header("content-disposition", `attachment; filename="mirror-conversation.${query.format === "json" ? "json" : "md"}"`);
    if (query.format === "json") return exported;
    return reply.type("text/markdown; charset=utf-8").send([
      `# ${conversation.title}`, "Transcript archive; importing this file does not create a resumable upstream thread.",
      ...[...exported.instructions, ...messages].map(message => `## ${message.role}\n\n${message.content}`),
      ...(query.attachments === "true" || query.metadata === "true" ? ["## Selected archive details", JSON.stringify(exported, null, 2)] : []),
    ].join("\n\n"));
  });
}
