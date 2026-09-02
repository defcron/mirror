import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ConversationSessionState, NormalizedConversationEvent, RemoteConversationSummary, UploadedFile } from "@mirror/protocol";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATA_DIR = process.env.MIRROR_DATA_DIR ?? path.join(PROJECT_ROOT, ".data");
const DATABASE_FILE = path.join(DATA_DIR, "mirror.db");
const KEY_FILE = path.join(DATA_DIR, "master.key");
const LEGACY_STORE_FILE = path.join(DATA_DIR, "store.json");

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function decodeConfiguredKey(value: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, "hex") : Buffer.from(value, "base64");
  if (key.byteLength !== 32) throw new Error("MIRROR_STORE_KEY must decode to exactly 32 bytes");
  return key;
}

function loadEncryptionKey(): Buffer {
  if (process.env.MIRROR_STORE_KEY) return decodeConfiguredKey(process.env.MIRROR_STORE_KEY);
  if (existsSync(KEY_FILE)) return Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
  return key;
}

const encryptionKey = loadEncryptionKey();

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decrypt(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Unsupported encrypted value");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

const db = new DatabaseSync(DATABASE_FILE);
chmodSync(DATABASE_FILE, 0o600);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL DEFAULT 'default', upstream_id TEXT,
    current_node_id TEXT NOT NULL, model TEXT NOT NULL, gizmo_id TEXT, title TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(account_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS openai_mappings (
    fingerprint TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    current_node_id TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const messageColumns = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
if (!messageColumns.some((column) => column.name === "attachments_json")) {
  db.exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'");
}
db.prepare("UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'").run();

export interface StoredSession {
  sessionToken: string;
  deviceId: string;
  savedAt: string;
  accountId?: string;
  cachedAccessToken?: string;
  cachedAccessTokenExpiresAt?: number;
}

function readSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(key, value, new Date().toISOString());
}

function migrateLegacyStore(): void {
  if (!existsSync(LEGACY_STORE_FILE) || readSetting("session")) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_STORE_FILE, "utf8")) as { session?: StoredSession | null };
    if (legacy.session?.sessionToken) writeSetting("session", encrypt(JSON.stringify(legacy.session)));
    unlinkSync(LEGACY_STORE_FILE);
  } catch {
    // Leave an unreadable legacy file untouched so recovery remains possible.
  }
}
migrateLegacyStore();
const storedAccountId = getSession()?.accountId;
if (storedAccountId) claimDefaultAccountData(storedAccountId);

export function databaseHealthy(): boolean {
  return (db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
}

export function getSession(): StoredSession | null {
  const sealed = readSetting("session");
  return sealed ? JSON.parse(decrypt(sealed)) as StoredSession : null;
}

export function saveVerifiedSession(sessionToken: string, accountId?: string, deviceId?: string): StoredSession {
  const prior = getSession();
  const session: StoredSession = {
    sessionToken, deviceId: deviceId ?? prior?.deviceId ?? randomUUID(), savedAt: new Date().toISOString(),
    ...(accountId ? { accountId } : {}),
  };
  writeSetting("session", encrypt(JSON.stringify(session)));
  return session;
}

export function updateMintedToken(accessToken: string, expiresAt: number, rotatedSessionToken: string | null): void {
  const session = getSession();
  if (!session) return;
  session.cachedAccessToken = accessToken;
  session.cachedAccessTokenExpiresAt = expiresAt;
  if (rotatedSessionToken) session.sessionToken = rotatedSessionToken;
  writeSetting("session", encrypt(JSON.stringify(session)));
}

export function clearSession(): void {
  db.prepare("DELETE FROM settings WHERE key = 'session'").run();
}

/** Attach pre-account-key local data from earlier builds to the verified account. */
export function claimDefaultAccountData(accountId: string): void {
  db.prepare("UPDATE conversations SET account_id = ? WHERE account_id = 'default'").run(accountId);
  db.prepare("UPDATE files SET account_id = ? WHERE account_id = 'default'").run(accountId);
}

export interface StoredConversation extends ConversationSessionState {
  id: string;
  accountId: string;
  title: string;
  init?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

function mapConversation(row: Record<string, unknown>): StoredConversation {
  return {
    id: String(row.id), accountId: String(row.account_id),
    conversationId: row.upstream_id ? String(row.upstream_id) : null,
    currentNodeId: String(row.current_node_id), model: String(row.model),
    gizmoId: row.gizmo_id ? String(row.gizmo_id) : null, initialized: Boolean(row.initialized),
    title: String(row.title), init: row.init_json ? JSON.parse(String(row.init_json)) : null,
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

export function createConversation(input: { model: string; gizmoId?: string | null; title?: string; accountId?: string }): StoredConversation {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(`INSERT INTO conversations
    (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, created_at, updated_at)
    VALUES (?, ?, NULL, 'client-created-root', ?, ?, ?, 0, ?, ?)`)
    .run(id, input.accountId ?? "default", input.model, input.gizmoId ?? null, input.title ?? "New chat", now, now);
  return getConversation(id)!;
}

export function getConversation(id: string): StoredConversation | null {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? mapConversation(row) : null;
}

export function listConversations(accountId = "default"): StoredConversation[] {
  return (db.prepare("SELECT * FROM conversations WHERE account_id = ? ORDER BY updated_at DESC").all(accountId) as Record<string, unknown>[]).map(mapConversation);
}

export function updateConversation(conversation: StoredConversation): void {
  db.prepare(`UPDATE conversations SET upstream_id=?, current_node_id=?, model=?, gizmo_id=?, title=?, initialized=?, init_json=?, updated_at=? WHERE id=?`)
    .run(conversation.conversationId, conversation.currentNodeId, conversation.model, conversation.gizmoId ?? null,
      conversation.title, conversation.initialized ? 1 : 0, conversation.init ? JSON.stringify(conversation.init) : null,
      new Date().toISOString(), conversation.id);
}

export function setConversationModel(id: string, model: string): StoredConversation | null {
  db.prepare("UPDATE conversations SET model=?, updated_at=? WHERE id=?").run(model, new Date().toISOString(), id);
  return getConversation(id);
}

/** Mirror the official sidebar while preserving Mirror's stable local ids. */
export function syncRemoteConversations(items: RemoteConversationSummary[], accountId: string): void {
  const find = db.prepare("SELECT id FROM conversations WHERE account_id=? AND upstream_id=?");
  const insert = db.prepare(`INSERT INTO conversations
    (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'auto', ?, ?, 1, ?, ?)`);
  const update = db.prepare(`UPDATE conversations SET title=?, gizmo_id=COALESCE(?, gizmo_id),
    current_node_id=CASE WHEN current_node_id='client-created-root' THEN ? ELSE current_node_id END,
    updated_at=? WHERE id=?`);
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const row = find.get(accountId, item.id) as { id: string } | undefined;
      if (row) update.run(item.title, item.gizmoId, item.currentNodeId ?? "client-created-root", item.updateTime, row.id);
      else insert.run(randomUUID(), accountId, item.id, item.currentNodeId ?? "client-created-root", item.gizmoId, item.title, item.createTime, item.updateTime);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function textFromRemoteMessage(message: Record<string, unknown>): string {
  const content = message.content && typeof message.content === "object" ? message.content as Record<string, unknown> : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.filter((part): part is string => typeof part === "string").join("");
}

export function importRemoteConversation(localId: string, raw: Record<string, unknown>): StoredConversation | null {
  const conversation = getConversation(localId);
  if (!conversation) return null;
  const mapping = raw.mapping && typeof raw.mapping === "object" ? raw.mapping as Record<string, unknown> : {};
  const current = typeof raw.current_node === "string" ? raw.current_node : conversation.currentNodeId;
  const chain: Array<Record<string, unknown>> = [];
  let cursor: string | null = current;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: unknown = mapping[cursor];
    if (!node || typeof node !== "object") break;
    chain.push(node as Record<string, unknown>);
    cursor = typeof (node as Record<string, unknown>).parent === "string" ? String((node as Record<string, unknown>).parent) : null;
  }
  chain.reverse();
  const existing = new Set(listMessages(localId).map((message) => message.upstreamNodeId).filter(Boolean));
  for (const node of chain) {
    const message = node.message && typeof node.message === "object" ? node.message as Record<string, unknown> : null;
    if (!message || typeof message.id !== "string" || existing.has(message.id)) continue;
    const author = message.author && typeof message.author === "object" ? message.author as Record<string, unknown> : {};
    const role = author.role;
    if (role !== "user" && role !== "assistant") continue;
    addMessage({ conversationId: localId, upstreamNodeId: message.id, role, content: textFromRemoteMessage(message), status: String(message.status ?? "done"), events: [] });
    existing.add(message.id);
  }
  conversation.currentNodeId = current;
  conversation.model = typeof raw.default_model_slug === "string" ? raw.default_model_slug : conversation.model;
  conversation.gizmoId = typeof raw.gizmo_id === "string" ? raw.gizmo_id : conversation.gizmoId;
  conversation.title = typeof raw.title === "string" ? raw.title : conversation.title;
  updateConversation(conversation);
  return getConversation(localId);
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  upstreamNodeId: string | null;
  role: "user" | "assistant";
  content: string;
  status: string;
  events: NormalizedConversationEvent[];
  attachments?: UploadedFile[];
  createdAt: string;
}

export function addMessage(input: Omit<StoredMessage, "id" | "createdAt"> & { id?: string }): StoredMessage {
  const message: StoredMessage = { ...input, id: input.id ?? randomUUID(), createdAt: new Date().toISOString() };
  db.prepare(`INSERT INTO messages(id, conversation_id, upstream_node_id, role, content, status, events_json, attachments_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(message.id, message.conversationId, message.upstreamNodeId, message.role, message.content,
      message.status, JSON.stringify(message.events), JSON.stringify(message.attachments ?? []), message.createdAt);
  return message;
}

export function updateMessage(id: string, content: string, status: string, upstreamNodeId: string | null, events: NormalizedConversationEvent[]): void {
  db.prepare("UPDATE messages SET content=?, status=?, upstream_node_id=?, events_json=? WHERE id=?")
    .run(content, status, upstreamNodeId, JSON.stringify(events), id);
}

export function listMessages(conversationId: string): StoredMessage[] {
  const rows = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid").all(conversationId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id), conversationId: String(row.conversation_id),
    upstreamNodeId: row.upstream_node_id ? String(row.upstream_node_id) : null,
    role: row.role as StoredMessage["role"], content: String(row.content), status: String(row.status),
    events: JSON.parse(String(row.events_json)), attachments: JSON.parse(String(row.attachments_json ?? "[]")), createdAt: String(row.created_at),
  }));
}

export function saveFile(file: UploadedFile, accountId = "default"): void {
  db.prepare(`INSERT INTO files(id, account_id, metadata_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json`)
    .run(file.fileId, accountId, JSON.stringify(file), new Date().toISOString());
}

export function deleteConversation(id: string): void {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function branchConversation(sourceId: string, currentNodeId: string, title = "Branched chat", throughMessageId?: string): StoredConversation | null {
  const source = getConversation(sourceId);
  if (!source) return null;
  const branch = createConversation({ model: source.model, gizmoId: source.gizmoId, title, accountId: source.accountId });
  branch.conversationId = source.conversationId;
  branch.currentNodeId = currentNodeId;
  branch.initialized = source.initialized;
  branch.init = source.init;
  updateConversation(branch);
  if (throughMessageId) {
    for (const message of listMessages(sourceId)) {
      addMessage({ ...message, id: undefined, conversationId: branch.id });
      if (message.id === throughMessageId) break;
    }
  }
  return getConversation(branch.id);
}

export function fingerprintMessages(messages: unknown): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export function saveOpenAiMapping(fingerprint: string, conversationId: string, currentNodeId: string): void {
  db.prepare(`INSERT INTO openai_mappings(fingerprint, conversation_id, current_node_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET conversation_id=excluded.conversation_id, current_node_id=excluded.current_node_id, updated_at=excluded.updated_at`)
    .run(fingerprint, conversationId, currentNodeId, new Date().toISOString());
}

export function getOpenAiMapping(fingerprint: string): { conversationId: string; currentNodeId: string } | null {
  const row = db.prepare("SELECT conversation_id, current_node_id FROM openai_mappings WHERE fingerprint = ?").get(fingerprint) as
    { conversation_id: string; current_node_id: string } | undefined;
  return row ? { conversationId: row.conversation_id, currentNodeId: row.current_node_id } : null;
}
