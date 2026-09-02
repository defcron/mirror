import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { z, ZodError } from "zod";
import { ChatGptBackendClient, normalizeGizmos, normalizeModels, type NormalizedConversationEvent } from "@mirror/protocol";
import { getValidCredentials, verifyCandidateSessionToken } from "./auth.js";
import { runChat, stopConversation } from "./chat-service.js";
import { registerOpenAiRoutes } from "./openai.js";
import {
  branchConversation, claimDefaultAccountData, clearSession, createConversation, databaseHealthy, deleteConversation,
  getConversation, getSession, importRemoteConversation, listConversations, listMessages, saveFile, saveVerifiedSession,
  setConversationModel, syncRemoteConversations, updateMintedToken,
} from "./store.js";

const app = Fastify({
  logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.body.sessionToken"] },
  bodyLimit: 2 * 1024 * 1024,
});
await app.register(cors, { origin: process.env.MIRROR_WEB_ORIGIN ?? "http://localhost:5173" });
await app.register(rateLimit, { global: true, max: 180, timeWindow: "1 minute" });
await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const configuredApiKeys = (process.env.MIRROR_API_KEYS ?? process.env.MIRROR_API_KEY ?? "").split(",").map((v) => v.trim()).filter(Boolean);
const accountKey = () => getSession()?.accountId ?? "default";
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/v1/") || configuredApiKeys.length === 0) return;
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configuredApiKeys.includes(token)) return reply.code(401).send({ error: { message: "Invalid Mirror API key", type: "authentication_error" } });
});

app.setErrorHandler((error, _req, reply) => {
  const status = error instanceof ZodError ? 400 : Number((error as { statusCode?: number }).statusCode ?? 500);
  const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : error instanceof Error ? error.message : "Internal error";
  if (status >= 500) app.log.error({ err: error }, "request failed");
  reply.code(status).send({ error: message });
});

app.get("/api/health", async () => ({ ok: databaseHealthy(), storage: "sqlite", configured: Boolean(getSession()) }));

const SetSessionBody = z.object({ sessionToken: z.string().min(20, "That doesn't look like a valid session token") });
app.post("/api/session", async (req) => {
  const body = SetSessionBody.parse(req.body);
  const candidate = await verifyCandidateSessionToken(body.sessionToken);
  const client = new ChatGptBackendClient(candidate.credentials);
  const me = await client.fetchMe();
  saveVerifiedSession(candidate.persistedSessionToken, client.accountId ?? undefined, candidate.credentials.deviceId);
  if (client.accountId) claimDefaultAccountData(client.accountId);
  updateMintedToken(candidate.credentials.accessToken, candidate.expiresAt, null);
  return { ok: true, accountId: client.accountId, email: typeof me.email === "string" ? me.email : null };
});

app.get("/api/session", async () => {
  const session = getSession();
  return { configured: Boolean(session), savedAt: session?.savedAt ?? null };
});
app.delete("/api/session", async () => { clearSession(); return { ok: true }; });

app.get("/api/models", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  return normalizeModels(await client.fetchModels());
});
app.get("/api/gpts", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  const raw = await client.fetchGizmoSidebar({ ownedOnly: false, limit: 50, conversationsPerGizmo: 0 });
  return normalizeGizmos(raw);
});

const NewConversationBody = z.object({ model: z.string().default("auto"), gizmoId: z.string().nullable().optional() });
app.get("/api/conversations", async () => {
  const client = new ChatGptBackendClient(await getValidCredentials());
  const first = await client.fetchConversations({ limit: 100 });
  const items = [...first.items];
  for (let offset = items.length; offset < first.total; offset += 100) {
    const page = await client.fetchConversations({ offset, limit: 100 });
    items.push(...page.items);
    if (page.items.length === 0) break;
  }
  syncRemoteConversations(items, accountKey());
  return listConversations(accountKey());
});
app.post("/api/conversations", async (req) => createConversation({ ...NewConversationBody.parse(req.body), accountId: accountKey() }));
app.get("/api/conversations/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  let conversation = getConversation(id);
  if (conversation?.accountId !== accountKey()) return reply.code(404).send({ error: "Conversation not found" });
  if (conversation.conversationId && listMessages(id).length === 0) {
    const client = new ChatGptBackendClient(await getValidCredentials());
    conversation = importRemoteConversation(id, await client.fetchConversation(conversation.conversationId));
  }
  return { conversation, messages: listMessages(id) };
});
app.patch("/api/conversations/:id", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return reply.code(404).send({ error: "Conversation not found" });
  return setConversationModel(id, z.object({ model: z.string().min(1) }).parse(req.body).model);
});
app.delete("/api/conversations/:id", async (req) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return { ok: false };
  stopConversation(id); deleteConversation(id); return { ok: true };
});
app.post("/api/conversations/:id/stop", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return reply.code(404).send({ error: "Conversation not found" });
  return { ok: stopConversation(id) };
});
app.post("/api/conversations/:id/branch", async (req, reply) => {
  const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
  if (getConversation(id)?.accountId !== accountKey()) return reply.code(404).send({ error: "Conversation not found" });
  const body = z.object({ messageId: z.string().uuid(), title: z.string().optional() }).parse(req.body);
  const target = listMessages(id).find((message) => message.id === body.messageId && message.upstreamNodeId);
  if (!target?.upstreamNodeId) return reply.code(400).send({ error: "That message cannot be used as a branch point" });
  return branchConversation(id, target.upstreamNodeId, body.title, body.messageId);
});

app.post("/api/files", async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: "No file uploaded" });
  const data = await part.toBuffer();
  const client = new ChatGptBackendClient(await getValidCredentials());
  await client.fetchMe().catch(() => undefined);
  const file = await client.uploadFile({ data, fileName: part.filename, mimeType: part.mimetype });
  saveFile(file, accountKey());
  return file;
});

app.get("/api/assets", async (req, reply) => {
  const query = z.object({ pointer: z.string(), upstreamConversationId: z.string().optional() }).parse(req.query);
  if (!query.pointer.startsWith("file-service://") && !query.pointer.startsWith("sediment://")) {
    return reply.code(400).send({ error: "Unsupported asset pointer" });
  }
  const client = new ChatGptBackendClient(await getValidCredentials());
  const url = await client.resolveAssetDownload(query.pointer, query.upstreamConversationId);
  return reply.redirect(url);
});

function publicEvent(event: NormalizedConversationEvent): Record<string, unknown> | null {
  if (event.kind === "raw" || event.kind === "assistant_text" || event.kind === "message") return null;
  const { raw: _raw, ...safe } = event as NormalizedConversationEvent & { raw?: unknown };
  return safe;
}

const ChatBody = z.object({
  prompt: z.string().min(1), model: z.string().default("auto"), conversationId: z.string().uuid().nullable().optional(),
  gizmoId: z.string().nullable().optional(), timezone: z.string().optional(), timezoneOffsetMin: z.number().optional(),
  attachments: z.array(z.object({
    fileId: z.string(), fileName: z.string(), fileSize: z.number(), mimeType: z.string(),
    useCase: z.enum(["multimodal", "my_files"]), width: z.number().optional(), height: z.number().optional(), raw: z.record(z.unknown()),
  })).default([]),
});

app.post("/api/chat", async (req, reply) => {
  const body = ChatBody.parse(req.body);
  const controller = new AbortController();
  req.raw.once("aborted", () => controller.abort());
  reply.raw.once("close", () => { if (!reply.raw.writableEnded) controller.abort(); });
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive", "X-Accel-Buffering": "no",
  });
  reply.raw.socket?.setNoDelay(true);
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { conversation, result, storedAssistantMessageId } = await runChat({
      ...body, signal: controller.signal,
      onDelta: (delta) => send("delta", { delta }),
      onEvent: (event) => { const safe = publicEvent(event); if (safe) send("event", safe); },
    });
    send("done", { text: result.text, conversationId: conversation.id, upstreamConversationId: result.conversationId,
      messageId: result.messageId, assistantMessageId: storedAssistantMessageId, model: conversation.model, init: conversation.init });
  } catch (error) {
    send("error", { message: error instanceof Error && error.name === "AbortError" ? "Generation stopped" : String((error as Error)?.message ?? error) });
  } finally {
    reply.raw.end();
  }
});

await registerOpenAiRoutes(app);

const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
await app.register(fastifyStatic, { root: staticRoot, wildcard: false });
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith("/api/") || req.url.startsWith("/v1/")) return reply.code(404).send({ error: "Not found" });
  return reply.sendFile("index.html");
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
app.log.info(`mirror server listening on http://${host}:${port}`);
