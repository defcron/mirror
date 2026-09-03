import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ChatGptBackendClient, normalizeGizmos, normalizeModels } from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import { runChat } from "./chat-service.js";
import { getConversation, getSession } from "./store.js";

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
  /**
   * Official OpenAI field, repurposed rather than adding a new one: whether
   * this turn is attached to a continuable Mirror conversation thread.
   * Defaults to true (persistent threads by default, mirroring how real
   * ChatGPT conversations behave); pass store:false for a one-shot message
   * that will not be resumable by a later /v1/chat/completions call.
   */
  store: z.boolean().default(true),
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
   *  - metadata.conversation_id = "..." -> the ONLY way to continue a
   *                                       thread across calls (this API is
   *                                       otherwise fully stateless, like
   *                                       real OpenAI's). Reuse an id
   *                                       returned via the
   *                                       x-mirror-conversation-id response
   *                                       header to continue that thread, or
   *                                       supply your own new id up front to
   *                                       name a brand-new conversation.
   *                                       Omit it and every call starts a
   *                                       fresh, unrelated conversation.
   */
  metadata: z.record(z.string(), z.string()).optional(),
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
function routeModel(model: string, metadata?: Record<string, string>): { model?: string; gizmoId?: string | null; private?: boolean } {
  const override = metadata?.mirror_model;
  const isPrivate = metadata?.private === "true";
  if (/^g-/.test(model)) return { model: override || "auto", gizmoId: model, private: isPrivate };
  return { model: override || model, private: isPrivate };
}

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
function withConversationLock<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const prior = conversationLocks.get(key) ?? Promise.resolve();
  const queued = prior.catch(() => undefined);
  const settled = queued.then(fn);
  const tracked = settled.catch(() => undefined);
  conversationLocks.set(key, tracked);
  tracked.finally(() => { if (conversationLocks.get(key) === tracked) conversationLocks.delete(key); });
  return settled;
}

export async function registerOpenAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/models", async () => {
    const creds = await getValidCredentials();
    const client = new ChatGptBackendClient(creds);
    const [models, projectsRaw, gptsRaw] = await Promise.all([
      normalizeModels(await client.fetchModels()),
      client.fetchGizmoSidebar({ ownedOnly: false, limit: 50, conversationsPerGizmo: 0 }).catch(() => ({})),
      client.fetchGizmoBootstrap({ limit: 20 }).catch(() => ({})),
    ]);
    const seen = new Set<string>();
    const gizmos = [...normalizeGizmos(gptsRaw), ...normalizeGizmos(projectsRaw)].filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    return {
      object: "list",
      data: [
        ...models.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "chatgpt-web" })),
        ...gizmos.map((gizmo) => ({
          id: gizmo.id, object: "model", created: 0,
          owned_by: gizmo.id.startsWith("g-p-") ? "chatgpt-project" : "chatgpt-gizmo",
          name: gizmo.name,
        })),
      ],
    };
  });

  app.post("/v1/chat/completions", async (req: FastifyRequest, reply) => {
    const body = CompletionBody.parse(req.body);
    const messages = normalized(body.messages);
    const last = messages.at(-1);
    if (!last || last.role !== "user") return reply.code(400).send({ error: { message: "The final message must have role=user", type: "invalid_request_error" } });
    if (!last.content.trim()) {
      // An empty final turn (e.g. a client that pre-appends a fresh blank
      // user row after each reply for convenience, then gets submitted
      // before anything is typed into it) would otherwise be forwarded to
      // ChatGPT as a genuinely content-free message - the GPT notices
      // nothing came through and replies saying so, and depending on the
      // client's own history bookkeeping that reply can end up rendered
      // back-to-back with the prior one, with no visible user text between.
      return reply.code(400).send({ error: { message: "The final user message must not be empty", type: "invalid_request_error" } });
    }

    // store:false means "one-shot": this call never continues (or is
    // continuable from) any thread, even if metadata.conversation_id is
    // supplied - it always gets its own throwaway conversation and never
    // returns x-mirror-conversation-id. See CompletionBody above.
    const oneShot = body.store === false;

    // metadata.conversation_id is the ONLY continuation mechanism (see
    // CompletionBody above) - this API is otherwise fully stateless, like
    // real OpenAI's; there is no prefix/message-history matching anymore.
    // If it doesn't exist yet, that's not an error - the caller is picking
    // their own id for a brand-new conversation, so we create one using
    // that id. It's only a conflict if the id is already taken by a
    // conversation on a different account.
    const explicitConversationId = !oneShot ? body.metadata?.conversation_id : undefined;
    const explicitConversation = explicitConversationId ? getConversation(explicitConversationId) : null;
    if (explicitConversation && explicitConversation.accountId !== (getSession()?.accountId ?? "default")) {
      return reply.code(400).send({ error: { message: `metadata.conversation_id is already in use: ${explicitConversationId}`, type: "invalid_request_error" } });
    }
    const newConversationId = explicitConversationId && !explicitConversation ? explicitConversationId : undefined;
    // Same key a concurrent duplicate call (double-click, eager retry, etc)
    // for this exact conversation_id would compute, so they serialize
    // against each other rather than both reading the same "current head"
    // and branching off it at once (see withConversationLock above).
    const lockKey = explicitConversationId ?? null;
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
      await withConversationLock(lockKey, async () => {
        const continuing = Boolean(explicitConversation);
        const route = routeModel(body.model, body.metadata);
        const { conversation, result } = await runChat({
          conversationId: explicitConversation?.id, newConversationId, prompt: promptFor(messages, continuing), model: route.model, gizmoId: route.gizmoId,
          private: route.private, signal: controller.signal,
          onDelta: body.stream ? (delta) => sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: body.model,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }) : undefined,
        });

        if (body.stream) {
          // Not part of the OpenAI chunk schema: an SSE comment line (ignored
          // by any spec-compliant SSE parser) carrying the Mirror conversation
          // id, since HTTP response headers can no longer be set once the
          // stream has started and this may be a brand-new conversation whose
          // id was not known until runChat() returned.
          if (!oneShot) reply.raw.write(`: mirror-conversation-id ${conversation.id}\n\n`);
          sse(reply, { id: completionId, object: "chat.completion.chunk", created, model: conversation.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          sse(reply, "[DONE]");
          reply.raw.end();
          return;
        }
        if (!oneShot) reply.header("x-mirror-conversation-id", conversation.id);
        return reply.send({
          id: completionId, object: "chat.completion", created, model: conversation.model,
          choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
          usage: null,
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
      return reply.code(502).send({ error: { message, type: "mirror_error" } });
    }
  });
}
