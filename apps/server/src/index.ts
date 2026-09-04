import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import {
  ChatGptBackendClient,
  normalizeGizmos,
  normalizeModels,
  type NormalizedConversationEvent,
} from "@mirror/protocol";
import { getValidCredentials, verifyCandidateSessionToken } from "./auth.js";
import { runChat, stopConversation } from "./chat-service.js";
import { registerOpenAiRoutes } from "./openai.js";
import {
  injectionCss,
  injectionJs,
  proxyChatGpt,
  proxyWebSocketUpgrade,
} from "./proxy.js";
import {
  getEgressStatus,
  monitorRequiredEgress,
  verifyRequiredEgress,
} from "./egress.js";
import {
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  tokenMatches,
} from "./security.js";
import {
  branchConversation,
  claimDefaultAccountData,
  clearSession,
  countConversations,
  createConversation,
  databaseHealthy,
  deleteConversation,
  getConversation,
  getConversationSyncCursor,
  getSession,
  importRemoteConversation,
  listConversations,
  listMessages,
  saveFile,
  saveVerifiedSession,
  setConversationModel,
  setConversationSyncCursor,
  syncRemoteConversations,
  updateMintedToken,
  ownsFile,
  ownsUpstreamConversation,
} from "./store.js";

const app = Fastify({
  logger: {
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.body.sessionToken",
    ],
    serializers: {
      // Signed realtime/AJAX URLs can carry short-lived credentials in their
      // query string. Keep request logging useful without persisting them.
      req(req) {
        return {
          method: req.method,
          url: typeof req.url === "string" ? req.url.split("?", 1)[0] : req.url,
          host: req.headers?.host,
          remoteAddress: req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  },
  bodyLimit: 30 * 1024 * 1024,
});
await app.register(cors, {
  origin: process.env.MIRROR_WEB_ORIGIN ?? "http://localhost:5173",
  exposedHeaders: ["x-mirror-conversation-id"],
});
await app.register(rateLimit, {
  global: true,
  max: 180,
  timeWindow: "1 minute",
});
await app.register(multipart, {
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

const apiKeys = configuredApiKeys();
const accountKey = () => getSession()?.accountId ?? "default";
app.addHook("onRequest", async (req, reply) => {
  if (!isAllowedRequestHost(req.headers.host)) {
    return reply.code(421).send({ error: "Untrusted Host header" });
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    return reply
      .code(403)
      .send({ error: "Cross-origin control request rejected" });
  }
  if (!req.url.startsWith("/v1/") || apiKeys.length === 0) return;
  if (!tokenMatches(bearerToken(req.headers.authorization), apiKeys)) {
    return reply
      .code(401)
      .send({
        error: {
          message: "Invalid Mirror API key",
          type: "authentication_error",
        },
      });
  }
});

app.setErrorHandler((error, _req, reply) => {
  const status =
    error instanceof ZodError
      ? 400
      : Number((error as { statusCode?: number }).statusCode ?? 500);
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : status >= 500
        ? "Internal server error"
        : error instanceof Error
          ? error.message
          : "Request failed";
  if (status >= 500) app.log.error({ err: error }, "request failed");
  reply.code(status).send({ error: message });
});

app.get("/api/health", async () => ({
  ok:
    databaseHealthy() &&
    (!getEgressStatus().required || getEgressStatus().verified),
  storage: "sqlite",
  configured: Boolean(getSession()),
  egress: getEgressStatus(),
}));

const SetSessionBody = z.object({
  sessionToken: z
    .string()
    .min(20, "That doesn't look like a valid session token"),
});
app.post("/api/session", async (req) => {
  const body = SetSessionBody.parse(req.body);
  const candidate = await verifyCandidateSessionToken(body.sessionToken);
  const client = new ChatGptBackendClient(candidate.credentials);
  const me = await client.fetchMe();
  saveVerifiedSession(
    candidate.persistedSessionToken,
    client.accountId ?? undefined,
    candidate.credentials.deviceId,
  );
  if (client.accountId) claimDefaultAccountData(client.accountId);
  updateMintedToken(
    candidate.credentials.accessToken,
    candidate.expiresAt,
    null,
  );
  return {
    ok: true,
    accountId: client.accountId,
    email: typeof me.email === "string" ? me.email : null,
  };
});

app.get("/api/session", async () => {
  const session = getSession();
  return { configured: Boolean(session), savedAt: session?.savedAt ?? null };
});
app.delete("/api/session", async () => {
  clearSession();
  return { ok: true };
});

app.get("/api/models", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  return normalizeModels(await client.fetchModels()).map(
    ({ raw: _raw, ...model }) => model,
  );
});
app.get("/api/gpts", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  const [projects, gpts] = await Promise.all([
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
  return [...normalizeGizmos(gpts), ...normalizeGizmos(projects)]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .map(({ raw: _raw, ...gizmo }) => gizmo);
});

const NewConversationBody = z.object({
  model: z.string().default("auto"),
  gizmoId: z.string().nullable().optional(),
});
// Paginated so a UI (the Playground's "Load a conversation" list) can lazy
// load a large history as the user scrolls, instead of eagerly fetching
// every page of it up front. The full remote-sidebar sync - which walks
// every page of the real ChatGPT sidebar via fetchConversations, an O(total
// conversation count) series of upstream calls - only makes sense to redo
// on the *first* page of a fresh listing (or an explicit refresh); repeating
// it on every subsequent scroll-triggered page would turn "scroll down" into
// "re-fetch your entire ChatGPT history" on every scroll tick, so callers
// paging past offset 0 pass sync=false and get served straight from the
// local mirror of it instead.
const ConversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  sync: z.coerce.boolean().default(true),
  // Restart the incremental sync cursor from the very top instead of
  // resuming where a previous call left off - only worth paying for on an
  // explicit user-initiated refresh (see App.tsx), not on every page load.
  resync: z.coerce.boolean().default(false),
});
app.get("/api/conversations", async (req) => {
  const { limit, offset, sync, resync } = ConversationsQuery.parse(req.query);
  if (sync) {
    const accountId = accountKey();
    const client = new ChatGptBackendClient(await getValidCredentials());
    const cursor = resync
      ? { activeOffset: 0, activeDone: false, archivedOffset: 0, archivedDone: false }
      : getConversationSyncCursor(accountId);
    // Real ChatGPT's /backend-api/conversations does NOT report a stable
    // grand total in its `total` field - it reports something closer to
    // "at least offset + items-returned-so-far", which keeps climbing every
    // time you page further, and only settles once you've actually paged
    // past the real end (where items comes back empty). That ruled out
    // using an early page's `total` as a loop bound (a prior version of
    // this did, and it silently truncated syncs to a few hundred
    // conversations on any large account). But walking *all* the way to
    // the real end on every request - correct, but O(total conversation
    // count) upstream calls - turned a few-hundred-millisecond request into
    // a multi-minute one on an account with thousands of conversations,
    // and this endpoint gets hit on every page of the Playground's
    // conversation list AND after every completed run. So: only pull
    // however many more upstream pages are needed to cover *this*
    // request's offset+limit window beyond what's already locally synced,
    // persisting where we left off (see store.ts's ConversationSyncCursor)
    // so the next call - whether that's scrolling further or just loading
    // again later - resumes instead of restarting. Active conversations are
    // fetched before archived ones (is_archived is a separate upstream
    // query, not something one call returns both sides of).
    const MAX_PAGES_PER_CALL = 40; // up to ~4,000 *new* conversations of upstream work per request - generous headroom without being unbounded
    const need = offset + limit;
    const collected: Array<Awaited<ReturnType<typeof client.fetchConversations>>["items"][number]> = [];
    for (
      let page = 0;
      page < MAX_PAGES_PER_CALL &&
      countConversations(accountId) + collected.length < need &&
      (!cursor.activeDone || !cursor.archivedDone);
      page++
    ) {
      const archived = cursor.activeDone;
      const result = await client.fetchConversations({
        offset: archived ? cursor.archivedOffset : cursor.activeOffset,
        limit: 100,
        archived,
      });
      collected.push(...result.items);
      if (archived) {
        cursor.archivedOffset += result.items.length;
        if (result.items.length === 0) cursor.archivedDone = true;
      } else {
        cursor.activeOffset += result.items.length;
        if (result.items.length === 0) cursor.activeDone = true;
      }
    }
    if (collected.length) syncRemoteConversations(collected, accountId);
    setConversationSyncCursor(accountId, cursor);
  }
  const items = listConversations(accountKey(), { limit, offset });
  const total = countConversations(accountKey());
  return { items, total, hasMore: offset + items.length < total };
});
app.post("/api/conversations", async (req) =>
  createConversation({
    ...NewConversationBody.parse(req.body),
    accountId: accountKey(),
  }),
);
app.get("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  let conversation = getConversation(id);
  if (conversation?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  if (conversation.conversationId && listMessages(id).length === 0) {
    const client = new ChatGptBackendClient(await getValidCredentials());
    conversation = importRemoteConversation(
      id,
      await client.fetchConversation(conversation.conversationId),
    );
  }
  return { conversation, messages: listMessages(id) };
});
app.patch("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  return setConversationModel(
    id,
    z.object({ model: z.string().min(1) }).parse(req.body).model,
  );
});
app.delete("/api/conversations/:id", async (req) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return { ok: false };
  stopConversation(id);
  deleteConversation(id);
  return { ok: true };
});
app.post("/api/conversations/:id/stop", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  return { ok: stopConversation(id) };
});
app.post("/api/conversations/:id/branch", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  const body = z
    .object({ messageId: z.string().uuid(), title: z.string().optional() })
    .parse(req.body);
  const target = listMessages(id).find(
    (message) => message.id === body.messageId && message.upstreamNodeId,
  );
  if (!target?.upstreamNodeId)
    return reply
      .code(400)
      .send({ error: "That message cannot be used as a branch point" });
  return branchConversation(
    id,
    target.upstreamNodeId,
    body.title,
    body.messageId,
  );
});

app.post("/api/files", async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: "No file uploaded" });
  const data = await part.toBuffer();
  const client = new ChatGptBackendClient(await getValidCredentials());
  await client.fetchMe().catch(() => undefined);
  const file = await client.uploadFile({
    data,
    fileName: part.filename,
    mimeType: part.mimetype,
  });
  const publicFile = { ...file, raw: {} };
  saveFile(publicFile, accountKey());
  return publicFile;
});

app.get("/api/assets", async (req, reply) => {
  const query = z
    .object({
      pointer: z.string(),
      upstreamConversationId: z.string().optional(),
    })
    .parse(req.query);
  if (
    !query.pointer.startsWith("file-service://") &&
    !query.pointer.startsWith("sediment://")
  ) {
    return reply.code(400).send({ error: "Unsupported asset pointer" });
  }
  if (
    query.pointer.startsWith("file-service://") &&
    !ownsFile(query.pointer.slice("file-service://".length), accountKey())
  ) {
    return reply.code(404).send({ error: "File not found" });
  }
  if (
    query.pointer.startsWith("sediment://") &&
    (!query.upstreamConversationId ||
      !ownsUpstreamConversation(query.upstreamConversationId, accountKey()))
  ) {
    return reply.code(404).send({ error: "Conversation asset not found" });
  }
  const client = new ChatGptBackendClient(await getValidCredentials());
  const url = await client.resolveAssetDownload(
    query.pointer,
    query.upstreamConversationId,
  );
  return reply.redirect(url);
});

function publicEvent(
  event: NormalizedConversationEvent,
): Record<string, unknown> | null {
  if (
    event.kind === "raw" ||
    event.kind === "assistant_text" ||
    event.kind === "message"
  )
    return null;
  const { raw: _raw, ...safe } = event as NormalizedConversationEvent & {
    raw?: unknown;
  };
  return safe;
}

const ChatBody = z.object({
  prompt: z.string().min(1),
  model: z.string().default("auto"),
  conversationId: z.string().uuid().nullable().optional(),
  gizmoId: z.string().nullable().optional(),
  timezone: z.string().optional(),
  timezoneOffsetMin: z.number().optional(),
  attachments: z
    .array(
      z.object({
        fileId: z.string(),
        fileName: z.string(),
        fileSize: z.number(),
        mimeType: z.string(),
        useCase: z.enum(["multimodal", "my_files"]),
        width: z.number().optional(),
        height: z.number().optional(),
        raw: z.record(z.unknown()).default({}),
      }),
    )
    .default([]),
});

app.post("/api/chat", async (req, reply) => {
  const body = ChatBody.parse(req.body);
  if (
    body.attachments.some(
      (attachment) => !ownsFile(attachment.fileId, accountKey()),
    )
  ) {
    return reply
      .code(404)
      .send({ error: "One or more attachments do not belong to this account" });
  }
  const controller = new AbortController();
  req.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.socket?.setNoDelay(true);
  const send = (event: string, data: unknown) =>
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { conversation, result, storedAssistantMessageId } = await runChat({
      ...body,
      signal: controller.signal,
      onDelta: (delta) => send("delta", { delta }),
      onEvent: (event) => {
        const safe = publicEvent(event);
        if (safe) send("event", safe);
      },
    });
    send("done", {
      text: result.text,
      conversationId: conversation.id,
      upstreamConversationId: result.conversationId,
      messageId: result.messageId,
      assistantMessageId: storedAssistantMessageId,
      model: conversation.model,
      init: conversation.init,
    });
  } catch (error) {
    send("error", {
      message:
        error instanceof Error && error.name === "AbortError"
          ? "Generation stopped"
          : String((error as Error)?.message ?? error),
    });
  } finally {
    reply.raw.end();
  }
});

await registerOpenAiRoutes(app);

const staticRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
await app.register(fastifyStatic, {
  root: staticRoot,
  prefix: "/mirror/",
  wildcard: false,
  decorateReply: true,
});
app.get("/mirror/playground", (_req, reply) => reply.sendFile("index.html"));
app.get("/mirror/inject.css", (_req, reply) =>
  reply.type("text/css").send(injectionCss),
);
app.get("/mirror/inject.js", (_req, reply) =>
  reply.type("application/javascript").send(injectionJs),
);
app.setNotFoundHandler(async (req, reply) => {
  // Every Mirror-owned /api route is registered above. Any remaining route may
  // belong to the official ChatGPT frontend and must be proxied upstream.
  if (req.url.startsWith("/v1/"))
    return reply.code(404).send({ error: "Not found" });
  return proxyChatGpt(req, reply);
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await verifyRequiredEgress();
await app.listen({ port, host });
app.log.info(`mirror server listening on http://${host}:${port}`);
// The frontend also opens a raw WebSocket (realtime notifications) straight
// to the upstream host; Fastify itself has no built-in WebSocket support, so
// this proxies the HTTP upgrade through by hand, the same way every other
// request is proxied through proxyChatGpt().
app.server.on("upgrade", (req, socket, head) => {
  void proxyWebSocketUpgrade(req, socket, head).catch((error) => {
    app.log.error({ err: error }, "mirror websocket proxy failed");
    socket.destroy();
  });
});
monitorRequiredEgress((error) => {
  app.log.error(
    { err: error },
    "required WARP egress was lost; stopping Mirror to prevent direct fallback",
  );
  void app.close().finally(() => process.exit(1));
});
