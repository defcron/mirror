import { registerInsightRoutes } from "./insights.js";
import { registerAssetContentRoute } from "./asset-content.js";
import { apiError, recordFailure } from "./api-errors.js";
import { syncConversationPage, hasRemoteHistory } from "./conversation-sync.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { stringify as toYaml } from "yaml";
import { z, ZodError } from "zod";
import { buildOpenApiDocument } from "./openapi-document.js";
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
  controlCookie,
  authorizedLocalRequest,
  mayBootstrapBrowser,
  bearerToken,
  configuredApiKeys,
  isAllowedOrigin,
  isAllowedRequestHost,
  tokenMatches,
} from "./security.js";
import {
  getSessionRevision,
  assertSessionRevision,
  getInstructions,
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


function isPublicApiPath(url: string): boolean {
  const pathname = url.split("?", 1)[0];
  return pathname === "/v1/responses" || pathname === "/v1/models" || pathname === "/v1/chat/completions" || pathname === "/v1/capabilities";
}

export async function buildApp() {
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
  delegator: async (req: FastifyRequest) => ({
    // API clients authenticate with explicit bearer keys, not ambient cookies.
    // Preflight has no key; the actual request is authenticated below.
    origin: isAllowedRequestHost(req.headers.host) &&
      (isPublicApiPath(req.url) || isAllowedOrigin(req.headers.origin, req.headers.host))
      ? (req.headers.origin || false) : false,
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["x-mirror-conversation-id", "x-request-id"],
  }),
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
  reply.header("x-request-id", req.id);
  if (!isAllowedRequestHost(req.headers.host)) {
    return reply.code(421).send({ error: "Untrusted Host header" });
  }
  // Image tags and new-tab downloads cannot attach a Mirror bearer header.
  // This exact read-only route validates its own sealed, file-scoped ticket.
  if (["GET", "HEAD"].includes(req.method) && req.url.split("?", 1)[0] === "/api/asset-content") return;
  if (isPublicApiPath(req.url) && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    if (!tokenMatches(bearerToken(req.headers.authorization), configuredApiKeys())) {
      return reply.code(401).send({ error: {
        message: "Cross-origin API requests require a configured Mirror API key",
        type: "authentication_error",
      } });
    }
    return;
  }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (mutating && !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    return reply
      .code(403)
      .send({ error: "Cross-origin control request rejected" });
  }
  if (req.headers.origin && !isAllowedOrigin(req.headers.origin, req.headers.host))
    return reply.code(403).send({error: "Origin rejected"});
  if (mayBootstrapBrowser(req.method, req.url, req.headers)) {
    reply.header("Set-Cookie", controlCookie());
    return;
  }
  if (req.url === "/api/health" || req.url.startsWith("/mirror/assets/")) return;
  if (!authorizedLocalRequest(req.headers)) return reply.code(401).send({ error: { message: "Open Mirror in your browser or supply a configured Mirror API key", type: "authentication_error" } });
});

app.addHook("onSend", async (req, reply, payload) => {
  if (req.url.startsWith("/v1/") && reply.statusCode >= 400) {
    // Format direct route replies and Fastify/plugin failures alike. Every
    // /v1/ response - a route's own .send(), the notFoundHandler, the rate
    // limiter, and setErrorHandler above - is JSON, and Fastify's default
    // serializer has already turned it into a string by the time onSend
    // hooks run; likewise, every /v1/ error object this app itself
    // produces is shaped one of two ways: a bare string, or an object
    // with a .message (see openai.ts, insights.ts, and setErrorHandler).
    const parsed = JSON.parse(payload as string);
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error.message;
    const envelope = apiError(reply.statusCode, message, req.id);
    recordFailure(envelope.error.code, req.id);
    return JSON.stringify(envelope);
  }
  return payload;
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

app.post("/api/session", async (req) => {
  const body = SetSessionBody.parse(req.body);
  const revision = getSessionRevision();
  const candidate = await verifyCandidateSessionToken(body.sessionToken, body.turnstileToken);
  const client = new ChatGptBackendClient(candidate.credentials);
  const me = await client.fetchMe();
  assertSessionRevision(revision);
  saveVerifiedSession(
    candidate.persistedSessionToken,
    client.accountId ?? undefined,
    candidate.credentials.deviceId,
    body.turnstileToken ?? candidate.turnstileToken,
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
  return {
    configured: Boolean(session),
    savedAt: session?.savedAt ?? null,
    hasTurnstileToken: Boolean(session?.turnstileToken),
  };
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
app.get("/api/conversations", async (req) => {
  const { limit, offset, sync, resync } = ConversationsQuery.parse(req.query);
  if (sync) {
    const revision = getSessionRevision();
    const accountId = accountKey();
    const client = new ChatGptBackendClient(await getValidCredentials());
    assertSessionRevision(revision);
    await syncConversationPage(accountId, offset + limit, resync, async (options) => {
      assertSessionRevision(revision);
      const page = await client.fetchConversations(options);
      assertSessionRevision(revision);
      return page;
    });
  }
  const items = listConversations(accountKey(), { limit, offset });
  const total = countConversations(accountKey());
  return { items, total, hasMore: offset + items.length < total || hasRemoteHistory(accountKey()) };
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
  const { id } = ConversationIdParam.parse(req.params);
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
  return { conversation, messages: listMessages(id), instructions: getInstructions(id) };
});
app.patch("/api/conversations/:id", async (req, reply) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  return setConversationModel(id, ModelUpdateBody.parse(req.body).model);
});
app.delete("/api/conversations/:id", async (req) => {
  // Mirror conversation ids are UUIDs when auto-generated, but a caller can
  // also name their own via /v1/chat/completions' metadata.conversation_id
  // (e.g. an arbitrary slug) - accept any non-empty id here so a
  // Playground/API-driven conversation created that way can still be
  // browsed, loaded, and managed through these routes.
  const { id } = ConversationIdParam.parse(req.params);
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
  const { id } = ConversationIdParam.parse(req.params);
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
  const { id } = ConversationIdParam.parse(req.params);
  if (getConversation(id)?.accountId !== accountKey())
    return reply.code(404).send({ error: "Conversation not found" });
  const body = BranchBody.parse(req.body);
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
  const query = AssetsQuery.parse(req.query);
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
    event.displayHidden ||
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
    const turnstileToken =
      body.turnstileToken ??
      (typeof req.headers["openai-sentinel-turnstile-token"] === "string"
        ? req.headers["openai-sentinel-turnstile-token"]
        : undefined) ??
      (typeof req.headers["x-turnstile-token"] === "string"
        ? req.headers["x-turnstile-token"]
        : undefined);
    const { conversation, result, storedAssistantMessageId } = await runChat({
      ...body,
      turnstileToken,
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
await registerAssetContentRoute(app);
await registerInsightRoutes(app);

// OpenAPI: generated from the same Zod schemas the routes validate against
// (see openapi-document.ts) rather than a hand-maintained JSON file. `mode:
// "static"` tells @fastify/swagger to serve this document as-is instead of
// trying to introspect Fastify route schemas (most routes here validate
// manually with Zod inside the handler body, not via Fastify's own `schema`
// option, so there'd be nothing for the automatic mode to find).
await app.register(fastifySwagger, {
  mode: "static",
  // zod-openapi's OpenAPIObject type models the OpenAPI spec slightly more
  // strictly than @fastify/swagger's own openapi-types import (e.g. server
  // variable `enum` as string[] only, vs string[] | number[] | boolean[]) -
  // both describe the same real document shape, so this is a type-only cast,
  // not a runtime one.
  specification: { document: buildOpenApiDocument() as any },
});
await app.register(fastifySwaggerUi, { routePrefix: "/mirror/api-docs" });
const OpenApiQuery = z.object({ format: z.enum(["json", "yaml"]).default("json") });
app.get("/mirror/openapi", async (req, reply) => {
  const { format } = OpenApiQuery.parse(req.query);
  const doc = app.swagger();
  if (format === "yaml") return reply.type("application/yaml").send(toYaml(doc));
  return reply.type("application/json").send(doc);
});

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

return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const app = await buildApp();
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

}
