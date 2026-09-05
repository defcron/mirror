import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ChatGptBackendClient,
  normalizeGizmos,
  normalizeModels,
} from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import { runChat } from "./chat-service.js";
import {
  getSessionRevision,
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

const ContentPart = z
  .object({ type: z.literal("text"), text: z.string() })
  .strict();
const OpenAiMessage = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant", "tool"]),
    content: z.union([z.string(), z.array(ContentPart), z.null()]),
    name: z.string().optional(),
  })
  .passthrough();
const CompletionBody = z
  .object({
    model: z.string().default("auto"),
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
     */
    metadata: z
      .object({
        private: z.enum(["true", "false"]).optional(),
        mirror_model: z.string().min(1).optional(),
        conversation_id: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

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
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n");
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
  if (continuation) return messages.at(-1)?.content ?? "";
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
    if (!last.content.trim()) {
      // An empty final turn (e.g. a client that pre-appends a fresh blank
      // user row after each reply for convenience, then gets submitted
      // before anything is typed into it) would otherwise be forwarded to
      // ChatGPT as a genuinely content-free message - the GPT notices
      // nothing came through and replies saying so, and depending on the
      // client's own history bookkeeping that reply can end up rendered
      // back-to-back with the prior one, with no visible user text between.
      return reply.code(400).send({
        error: {
          message: "The final user message must not be empty",
          type: "invalid_request_error",
        },
      });
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
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.socket?.setNoDelay(true);
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
            signal: controller.signal,
            onDelta: body.stream
              ? (delta) =>
                  sse(reply, {
                    id: completionId,
                    object: "chat.completion.chunk",
                    created,
                    model: body.model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: delta },
                        finish_reason: null,
                      },
                    ],
                  })
              : undefined,
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
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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
              message: { role: "assistant", content: result.text },
              finish_reason: "stop",
            },
          ],
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
