import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChatGptBackendClient, normalizeModels } from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import { runChat } from "./chat-service.js";
import {
  branchConversation,
  fingerprintMessages,
  getOpenAiMapping,
  saveOpenAiMapping,
} from "./store.js";

const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough();
const OpenAiMessage = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ContentPart), z.null()]),
  name: z.string().optional(),
}).passthrough();
const CompletionBody = z.object({
  model: z.string().default("auto"),
  messages: z.array(OpenAiMessage).min(1),
  stream: z.boolean().default(false),
  user: z.string().optional(),
});

function textContent(content: z.infer<typeof OpenAiMessage>["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part.type === "text" && part.text).map((part) => part.text).join("\n");
}

function normalized(messages: z.infer<typeof OpenAiMessage>[]) {
  return messages.map((message) => ({ role: message.role, content: textContent(message.content), ...(message.name ? { name: message.name } : {}) }));
}

function promptFor(messages: ReturnType<typeof normalized>, continuation: boolean): string {
  if (continuation) return messages.at(-1)?.content ?? "";
  const system = messages.filter((m) => m.role === "system" || m.role === "developer");
  const conversational = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  if (messages.length === 1 && messages[0]?.role === "user") return messages[0].content;
  return [
    system.length ? `Instructions:\n${system.map((m) => m.content).join("\n")}` : "",
    "Conversation context:",
    conversational.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n"),
  ].filter(Boolean).join("\n\n");
}

function sse(reply: FastifyReply, data: unknown): void {
  reply.raw.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export async function registerOpenAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async () => {
    const models = normalizeModels(await new ChatGptBackendClient(await getValidCredentials()).fetchModels());
    return { object: "list", data: models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "chatgpt-web" })) };
  });

  app.post("/v1/chat/completions", async (req: FastifyRequest, reply) => {
    const body = CompletionBody.parse(req.body);
    const messages = normalized(body.messages);
    const last = messages.at(-1);
    if (!last || last.role !== "user") return reply.code(400).send({ error: { message: "The final message must have role=user", type: "invalid_request_error" } });

    const prefix = messages.slice(0, -1);
    const match = prefix.length ? getOpenAiMapping(fingerprintMessages(prefix)) : null;
    const branch = match ? branchConversation(match.conversationId, match.currentNodeId, last.content.slice(0, 54) || "API chat") : null;
    const completionId = `chatcmpl-${crypto.randomUUID().replaceAll("-", "")}`;
    const created = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    req.raw.once("aborted", () => controller.abort());
    reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive", "X-Accel-Buffering": "no",
      });
      reply.raw.socket?.setNoDelay(true);
      sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
    }

    try {
      const { conversation, result } = await runChat({
        conversationId: branch?.id, prompt: promptFor(messages, Boolean(match)), model: body.model, signal: controller.signal,
        onDelta: body.stream ? (delta) => sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }) : undefined,
      });
      saveOpenAiMapping(fingerprintMessages([...messages, { role: "assistant", content: result.text }]), conversation.id, result.messageId ?? conversation.currentNodeId);

      if (body.stream) {
        sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: conversation.model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        sse(reply, "[DONE]");
        reply.raw.end();
        return;
      }
      return reply.send({
        id: completionId, object: "chat.completion", created, model: conversation.model,
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        usage: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (body.stream) {
        sse(reply, { error: { message, type: "mirror_error" } });
        sse(reply, "[DONE]");
        reply.raw.end();
        return;
      }
      return reply.code(502).send({ error: { message, type: "mirror_error" } });
    }
  });
}
