import { resolveDataDirectory } from "./storage-config.js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type {
  ConversationSessionState,
  NormalizedConversationEvent,
  RemoteConversationSummary,
  UploadedFile,
} from "@mirror/protocol";

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DATA_DIR = resolveDataDirectory(PROJECT_ROOT, process.env.MIRROR_DATA_DIR);
const DATABASE_FILE = path.join(DATA_DIR, "mirror.db");
const KEY_FILE = path.join(DATA_DIR, "master.key");
const LEGACY_STORE_FILE = path.join(DATA_DIR, "store.json");

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function decodeConfiguredKey(value: string): Buffer {
  const key = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.byteLength !== 32)
    throw new Error("MIRROR_STORE_KEY must decode to exactly 32 bytes");
  return key;
}

function loadEncryptionKey(): Buffer {
  if (process.env.MIRROR_STORE_KEY)
    return decodeConfiguredKey(process.env.MIRROR_STORE_KEY);
  if (existsSync(KEY_FILE)) {
    chmodSync(KEY_FILE, 0o600);
    return decodeConfiguredKey(readFileSync(KEY_FILE, "utf8").trim());
  }
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
  return key;
}

const encryptionKey = loadEncryptionKey();

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decrypt(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("Unsupported encrypted value");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
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
    initialized INTEGER NOT NULL DEFAULT 0, init_json TEXT, is_private INTEGER NOT NULL DEFAULT 0,
    is_branch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(account_id, updated_at DESC);
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    upstream_node_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]', attachments_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS openai_contexts (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    instructions_hash TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS openai_transcripts (
    conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL, transcript_hash TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS openai_transcripts_hash_idx ON openai_transcripts(account_id, transcript_hash);
  CREATE TABLE IF NOT EXISTS conversation_instructions (conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, messages_json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
`);
const messageColumns = db
  .prepare("PRAGMA table_info(messages)")
  .all() as Array<{ name: string }>;
if (!messageColumns.some((column) => column.name === "attachments_json")) {
  db.exec(
    "ALTER TABLE messages ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]'",
  );
}
const conversationColumns = db
  .prepare("PRAGMA table_info(conversations)")
  .all() as Array<{ name: string }>;
if (!conversationColumns.some((column) => column.name === "is_private")) {
  db.exec(
    "ALTER TABLE conversations ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0",
  );
}
if (!conversationColumns.some((column) => column.name === "is_branch")) {
  db.exec(
    "ALTER TABLE conversations ADD COLUMN is_branch INTEGER NOT NULL DEFAULT 0",
  );
}
db.prepare(
  "UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'",
).run();

let sessionRevision = 0;
const sessionListeners = new Set<() => void>();
export function getSessionRevision(): number { return sessionRevision; }
export function onSessionChange(listener: () => void): () => void { sessionListeners.add(listener); return () => { sessionListeners.delete(listener); }; }
function changedSession(): void { sessionRevision++; for (const listener of sessionListeners) listener(); }
export function assertSessionRevision(expected: number): void {
  if (expected !== sessionRevision) throw Object.assign(new Error("Session changed; retry with the current account"), {statusCode: 409});
}
export interface StoredSession {
  sessionToken: string;
  deviceId: string;
  savedAt: string;
  assetLinkGeneration?: string;
  accountId?: string;
  cachedAccessToken?: string;
  cachedAccessTokenExpiresAt?: number;
}

function readSetting(key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}

function migrateLegacyStore(): void {
  if (!existsSync(LEGACY_STORE_FILE) || readSetting("session")) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_STORE_FILE, "utf8")) as {
      session?: StoredSession | null;
    };
    if (legacy.session?.sessionToken)
      writeSetting("session", encrypt(JSON.stringify(legacy.session)));
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
  return sealed ? (JSON.parse(decrypt(sealed)) as StoredSession) : null;
}

export function saveVerifiedSession(
  sessionToken: string,
  accountId?: string,
  deviceId?: string,
): StoredSession {
  changedSession();
  const prior = getSession();
  const session: StoredSession = {
    sessionToken,
    deviceId: deviceId ?? prior?.deviceId ?? randomUUID(),
    savedAt: new Date().toISOString(),
    assetLinkGeneration: randomUUID(),
    ...(accountId ? { accountId } : {}),
  };
  writeSetting("session", encrypt(JSON.stringify(session)));
  return session;
}

export function setSessionAccountId(accountId: string): void {
  const session = getSession();
  if (!session || session.accountId === accountId) return;
  session.accountId = accountId;
  writeSetting("session", encrypt(JSON.stringify(session)));
  claimDefaultAccountData(accountId);
}

export function updateMintedToken(
  accessToken: string,
  expiresAt: number,
  rotatedSessionToken: string | null,
): void {
  const session = getSession();
  if (!session) return;
  session.cachedAccessToken = accessToken;
  session.cachedAccessTokenExpiresAt = expiresAt;
  if (rotatedSessionToken) session.sessionToken = rotatedSessionToken;
  writeSetting("session", encrypt(JSON.stringify(session)));
}

export function clearSession(): void {
  changedSession();
  db.prepare("DELETE FROM settings WHERE key = 'session'").run();
}

export interface AssetTicket {
  pointer: string;
  conversationId: string | null;
  messageId: string | null;
  fileName: string;
}

/** A sealed, file-scoped capability; contains no API key or upstream URL.
 * No extra history or file bytes are persisted, including for store:false. */
export function sealAssetTicket(asset: AssetTicket, now = Date.now()): string {
  const session = getSession();
  if (!session) throw new Error("No session configured");
  return encrypt(JSON.stringify({ purpose: "mirror-asset-v1", ...asset,
    accountId: session.accountId ?? "default", sessionGeneration: session.assetLinkGeneration ?? session.savedAt,
    expiresAt: now + 7 * 24 * 60 * 60 * 1000 }));
}

export function openAssetTicket(ticket: string, now = Date.now()): AssetTicket | null {
  try {
    if (ticket.length > 12000) return null;
    const asset = JSON.parse(decrypt(ticket));
    const session = getSession();
    if (!session || asset.purpose !== "mirror-asset-v1" || asset.accountId !== (session.accountId ?? "default") ||
      asset.sessionGeneration !== (session.assetLinkGeneration ?? session.savedAt) || !Number.isFinite(asset.expiresAt) || asset.expiresAt <= now ||
      typeof asset.pointer !== "string" || !/^(?:file-service:\/\/|sediment:\/\/|sandbox:\/)/.test(asset.pointer) ||
      typeof asset.fileName !== "string" ||
      !(asset.conversationId === null || typeof asset.conversationId === "string") ||
      !(asset.messageId === null || typeof asset.messageId === "string")) return null;
    return { pointer: asset.pointer, conversationId: asset.conversationId, messageId: asset.messageId, fileName: asset.fileName };
  } catch { return null; }
}

/** Attach pre-account-key local data from earlier builds to the verified account. */
export function claimDefaultAccountData(accountId: string): void {
  db.prepare(
    "UPDATE conversations SET account_id = ? WHERE account_id = 'default'",
  ).run(accountId);
  db.prepare(
    "UPDATE files SET account_id = ? WHERE account_id = 'default'",
  ).run(accountId);
}

export interface StoredConversation extends ConversationSessionState {
  id: string;
  accountId: string;
  title: string;
  init?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  isBranch: boolean;
}

function mapConversation(row: Record<string, unknown>): StoredConversation {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    conversationId: row.upstream_id ? String(row.upstream_id) : null,
    currentNodeId: String(row.current_node_id),
    model: String(row.model),
    gizmoId: row.gizmo_id ? String(row.gizmo_id) : null,
    initialized: Boolean(row.initialized),
    private: Boolean(row.is_private),
    isBranch: Boolean(row.is_branch),
    title: String(row.title),
    init: row.init_json ? JSON.parse(String(row.init_json)) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createConversation(input: {
  id?: string;
  model: string;
  gizmoId?: string | null;
  private?: boolean;
  title?: string;
  accountId?: string;
}): StoredConversation {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO conversations
    (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, is_private, created_at, updated_at)
    VALUES (?, ?, NULL, 'client-created-root', ?, ?, ?, 0, ?, ?, ?)`,
  ).run(
    id,
    input.accountId ?? "default",
    input.model,
    input.gizmoId ?? null,
    input.title ?? "New chat",
    input.private ? 1 : 0,
    now,
    now,
  );
  return getConversation(id)!;
}

export function getConversation(id: string): StoredConversation | null {
  const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapConversation(row) : null;
}

export function listConversations(
  accountId = "default",
  page?: { limit: number; offset: number },
): StoredConversation[] {
  const rows = page
    ? (db
        .prepare(
          "SELECT * FROM conversations WHERE account_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
        )
        .all(accountId, page.limit, page.offset) as Record<string, unknown>[])
    : (db
        .prepare(
          "SELECT * FROM conversations WHERE account_id = ? ORDER BY updated_at DESC",
        )
        .all(accountId) as Record<string, unknown>[]);
  return rows.map(mapConversation);
}

export function countConversations(accountId = "default"): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE account_id = ?")
      .get(accountId) as { count: number }
  ).count;
}

/**
 * Where an account's incremental remote-sidebar sync last left off (see
 * index.ts's GET /api/conversations). ChatGPT's own conversations listing
 * has no cheap "give me the true total up front" answer (its `total` field
 * climbs as you page further rather than reporting a stable count - see the
 * comment in index.ts), so rather than walking a caller's *entire* upstream
 * history on every request - correct, but multi-minute on any account with
 * a large history - the sync resumes from here each time and only pulls
 * however many more pages the currently requested page of the local list
 * actually needs.
 */
export interface ConversationSyncCursor {
  activeOffset: number;
  activeDone: boolean;
  archivedOffset: number;
  archivedDone: boolean;
}
const DEFAULT_SYNC_CURSOR: ConversationSyncCursor = {
  activeOffset: 0,
  activeDone: false,
  archivedOffset: 0,
  archivedDone: false,
};
function syncCursorKey(accountId: string): string {
  return `conversation_sync_cursor:${accountId}`;
}
export function getConversationSyncCursor(
  accountId: string,
): ConversationSyncCursor {
  const raw = readSetting(syncCursorKey(accountId));
  if (!raw) return { ...DEFAULT_SYNC_CURSOR };
  try {
    return { ...DEFAULT_SYNC_CURSOR, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SYNC_CURSOR };
  }
}
export function setConversationSyncCursor(
  accountId: string,
  cursor: ConversationSyncCursor,
): void {
  writeSetting(syncCursorKey(accountId), JSON.stringify(cursor));
}

export function updateConversation(conversation: StoredConversation): void {
  db.prepare(
    `UPDATE conversations SET upstream_id=?, current_node_id=?, model=?, gizmo_id=?, title=?, initialized=?, init_json=?, is_private=?, is_branch=?, updated_at=? WHERE id=?`,
  ).run(
    conversation.conversationId,
    conversation.currentNodeId,
    conversation.model,
    conversation.gizmoId ?? null,
    conversation.title,
    conversation.initialized ? 1 : 0,
    conversation.init ? JSON.stringify(conversation.init) : null,
    conversation.private ? 1 : 0,
    conversation.isBranch ? 1 : 0,
    new Date().toISOString(),
    conversation.id,
  );
}

export function setConversationModel(
  id: string,
  model: string,
): StoredConversation | null {
  db.prepare("UPDATE conversations SET model=?, updated_at=? WHERE id=?").run(
    model,
    new Date().toISOString(),
    id,
  );
  return getConversation(id);
}

/** Mirror the official sidebar while preserving Mirror's stable local ids. */
export function syncRemoteConversations(
  items: RemoteConversationSummary[],
  accountId: string,
): void {
  const find = db.prepare(
    "SELECT id FROM conversations WHERE account_id=? AND upstream_id=? AND is_branch=0 ORDER BY created_at LIMIT 1",
  );
  const insert = db.prepare(`INSERT INTO conversations
    (id, account_id, upstream_id, current_node_id, model, gizmo_id, title, initialized, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'auto', ?, ?, 1, ?, ?)`);
  const update =
    db.prepare(`UPDATE conversations SET title=?, gizmo_id=COALESCE(?, gizmo_id),
    current_node_id=?, updated_at=? WHERE id=?`);
  db.exec("BEGIN");
  try {
    for (const item of items) {
      const row = find.get(accountId, item.id) as { id: string } | undefined;
      if (row)
        update.run(
          item.title,
          item.gizmoId,
          item.currentNodeId ?? "client-created-root",
          item.updateTime,
          row.id,
        );
      else
        insert.run(
          randomUUID(),
          accountId,
          item.id,
          item.currentNodeId ?? "client-created-root",
          item.gizmoId,
          item.title,
          item.createTime,
          item.updateTime,
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function textFromRemoteMessage(message: Record<string, unknown>): string {
  const content =
    message.content && typeof message.content === "object"
      ? (message.content as Record<string, unknown>)
      : {};
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("");
}

export function importRemoteConversation(
  localId: string,
  raw: Record<string, unknown>,
): StoredConversation | null {
  const conversation = getConversation(localId);
  if (!conversation) return null;
  const mapping =
    raw.mapping && typeof raw.mapping === "object"
      ? (raw.mapping as Record<string, unknown>)
      : {};
  const current =
    typeof raw.current_node === "string"
      ? raw.current_node
      : conversation.currentNodeId;
  const chain: Array<Record<string, unknown>> = [];
  let cursor: string | null = current;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: unknown = mapping[cursor];
    if (!node || typeof node !== "object") break;
    chain.push(node as Record<string, unknown>);
    cursor =
      typeof (node as Record<string, unknown>).parent === "string"
        ? String((node as Record<string, unknown>).parent)
        : null;
  }
  chain.reverse();
  const existing = new Set(
    listMessages(localId)
      .map((message) => message.upstreamNodeId)
      .filter(Boolean),
  );
  for (const node of chain) {
    const message =
      node.message && typeof node.message === "object"
        ? (node.message as Record<string, unknown>)
        : null;
    if (!message || typeof message.id !== "string" || existing.has(message.id))
      continue;
    const author =
      message.author && typeof message.author === "object"
        ? (message.author as Record<string, unknown>)
        : {};
    const role = author.role;
    if (role !== "user" && role !== "assistant") continue;
    addMessage({
      conversationId: localId,
      upstreamNodeId: message.id,
      role,
      content: textFromRemoteMessage(message),
      status: String(message.status ?? "done"),
      events: [],
    });
    existing.add(message.id);
  }
  conversation.currentNodeId = current;
  conversation.model =
    typeof raw.default_model_slug === "string"
      ? raw.default_model_slug
      : conversation.model;
  conversation.gizmoId =
    typeof raw.gizmo_id === "string" ? raw.gizmo_id : conversation.gizmoId;
  conversation.title =
    typeof raw.title === "string" ? raw.title : conversation.title;
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

export function addMessage(
  input: Omit<StoredMessage, "id" | "createdAt"> & { id?: string },
): StoredMessage {
  const message: StoredMessage = {
    ...input,
    id: input.id ?? randomUUID(),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO messages(id, conversation_id, upstream_node_id, role, content, status, events_json, attachments_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.conversationId,
    message.upstreamNodeId,
    message.role,
    message.content,
    message.status,
    JSON.stringify(message.events),
    JSON.stringify(message.attachments ?? []),
    message.createdAt,
  );
  return message;
}

export function updateMessage(
  id: string,
  content: string,
  status: string,
  upstreamNodeId: string | null,
  events: NormalizedConversationEvent[],
): void {
  db.prepare(
    "UPDATE messages SET content=?, status=?, upstream_node_id=?, events_json=? WHERE id=?",
  ).run(content, status, upstreamNodeId, JSON.stringify(events), id);
}

export function listMessages(conversationId: string): StoredMessage[] {
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid",
    )
    .all(conversationId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row.id),
    conversationId: String(row.conversation_id),
    upstreamNodeId: row.upstream_node_id ? String(row.upstream_node_id) : null,
    role: row.role as StoredMessage["role"],
    content: String(row.content),
    status: String(row.status),
    events: JSON.parse(String(row.events_json)),
    attachments: JSON.parse(String(row.attachments_json)),
    createdAt: String(row.created_at),
  }));
}

export function saveFile(file: UploadedFile, accountId = "default"): void {
  db.prepare(
    `INSERT INTO files(id, account_id, metadata_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET metadata_json=excluded.metadata_json`,
  ).run(file.fileId, accountId, JSON.stringify(file), new Date().toISOString());
}

export function ownsFile(fileId: string, accountId: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM files WHERE id=? AND account_id=?")
      .get(fileId, accountId),
  );
}

export function ownsUpstreamConversation(
  upstreamId: string,
  accountId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM conversations WHERE upstream_id=? AND account_id=?",
      )
      .get(upstreamId, accountId),
  );
}

export function deleteConversation(id: string): void {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

export function branchConversation(
  sourceId: string,
  currentNodeId: string,
  title = "Branched chat",
  throughMessageId?: string,
): StoredConversation | null {
  const source = getConversation(sourceId);
  if (!source) return null;
  const branch = createConversation({
    model: source.model,
    gizmoId: source.gizmoId,
    private: source.private,
    title,
    accountId: source.accountId,
  });
  branch.conversationId = source.conversationId;
  branch.currentNodeId = currentNodeId;
  branch.initialized = source.initialized;
  branch.init = source.init;
  branch.isBranch = true;
  updateConversation(branch);
  if (throughMessageId) {
    for (const message of listMessages(sourceId)) {
      addMessage({ ...message, id: undefined, conversationId: branch.id });
      if (message.id === throughMessageId) break;
    }
  }
  const instructions = getInstructions(sourceId);
  saveInstructions(branch.id, instructions);
  saveOpenAiContext(branch.id, fingerprintValue(instructions));
  saveOpenAiTranscript(branch.id, source.accountId, fingerprintValue([
    ...instructions, ...listMessages(branch.id).map(({ role, content }) => ({ role, content })),
  ]));
  return getConversation(branch.id);
}

export function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function saveOpenAiContext(
  conversationId: string,
  instructionsHash: string,
): void {
  db.prepare(
    `INSERT INTO openai_contexts(conversation_id, instructions_hash, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET instructions_hash=excluded.instructions_hash, updated_at=excluded.updated_at`,
  ).run(conversationId, instructionsHash, new Date().toISOString());
}

export function getOpenAiContext(conversationId: string): string | null {
  const row = db
    .prepare(
      "SELECT instructions_hash FROM openai_contexts WHERE conversation_id = ?",
    )
    .get(conversationId) as { instructions_hash: string } | undefined;
  return row?.instructions_hash ?? null;
}

/**
 * Fingerprint of "the full transcript this conversation's caller would
 * resend next time" (everything they sent this turn, including our own
 * reply, since a resent history necessarily echoes back what we returned).
 * Two things read this:
 *  - findConversationByTranscript: a caller with no metadata.conversation_id
 *    at all (a plain OpenAI-only client that manages its own history, e.g. a
 *    browser extension's "custom API" mode) gets matched back to the same
 *    Mirror conversation purely by recognizing its resent history, instead
 *    of spawning a brand-new upstream ChatGPT thread on every message.
 *  - the explicit metadata.conversation_id path compares the caller's
 *    freshly resent prior transcript against this to detect that they
 *    edited an earlier turn (e.g. in the Playground) rather than merely
 *    appending one - see rebaseConversationUpstream/replaceMessages below.
 */
export function saveOpenAiTranscript(
  conversationId: string,
  accountId: string,
  transcriptHash: string,
): void {
  db.prepare(
    `INSERT INTO openai_transcripts(conversation_id, account_id, transcript_hash, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET transcript_hash=excluded.transcript_hash, updated_at=excluded.updated_at`,
  ).run(conversationId, accountId, transcriptHash, new Date().toISOString());
}

export function getOpenAiTranscript(conversationId: string): string | null {
  const row = db
    .prepare(
      "SELECT transcript_hash FROM openai_transcripts WHERE conversation_id = ?",
    )
    .get(conversationId) as { transcript_hash: string } | undefined;
  return row?.transcript_hash ?? null;
}

export function findConversationByTranscript(
  accountId: string,
  transcriptHash: string,
): StoredConversation | null {
  const row = db
    .prepare(
      `SELECT conversation_id FROM openai_transcripts
       WHERE account_id = ? AND transcript_hash = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(accountId, transcriptHash) as { conversation_id: string } | undefined;
  return row ? getConversation(row.conversation_id) : null;
}

/**
 * Rebases a conversation inside its existing upstream ChatGPT thread while
 * keeping its Mirror id intact. ChatGPT does not expose an operation for
 * overwriting an already-generated assistant node, but its conversation
 * graph can accept a new branch under the same conversation_id. For a user
 * edit, currentNodeId is the real message immediately before the edited user
 * turn, so the replacement is sent as a normal user bubble rather than a
 * flattened transcript. Other rebase callers may explicitly choose root.
 */
export function rebaseConversationUpstream(
  id: string,
  overrides: {
    model?: string;
    gizmoId?: string | null;
    private?: boolean;
    currentNodeId?: string;
  } = {},
): void {
  const existing = getConversation(id);
  if (!existing) return;
  db.prepare(
    `UPDATE conversations SET current_node_id=?,
     model=?, gizmo_id=?, is_private=?, updated_at=? WHERE id=?`,
  ).run(
    overrides.currentNodeId ?? "client-created-root",
    overrides.model && overrides.model !== "auto" ? overrides.model : existing.model,
    overrides.gizmoId !== undefined ? overrides.gizmoId : (existing.gizmoId ?? null),
    (overrides.private !== undefined ? overrides.private : Boolean(existing.private)) ? 1 : 0,
    new Date().toISOString(),
    id,
  );
}

/** Replaces a conversation's locally stored message history wholesale (used
 * alongside rebaseConversationUpstream when a caller's edited transcript
 * becomes the new ground truth). Replayed prefix messages generally have no
 * real upstream node id because they were not sent as individual turns. The
 * fresh user/assistant pair can retain the ids, status and structured events
 * runChat observed for the real synthetic-context turn. */
export function replaceMessages(
  conversationId: string,
  entries: Array<{
    id?: string;
    upstreamNodeId?: string | null;
    role: "user" | "assistant";
    content: string;
    status?: string;
    events?: NormalizedConversationEvent[];
    attachments?: UploadedFile[];
  }>,
): void {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(
      conversationId,
    );
    for (const entry of entries) {
      addMessage({
        id: entry.id,
        conversationId,
        upstreamNodeId: entry.upstreamNodeId ?? null,
        role: entry.role,
        content: entry.content,
        status: entry.status ?? "done",
        events: entry.events ?? [],
        attachments: entry.attachments,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveInstructions(id: string, messages: Array<{role: string; content: string}>): void {
  db.prepare("INSERT INTO conversation_instructions VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET messages_json=excluded.messages_json").run(id, JSON.stringify(messages.filter(m => m.role === "system" || m.role === "developer")));
}
export function getInstructions(id: string): Array<{role: string; content: string}> {
  const row = db.prepare("SELECT messages_json FROM conversation_instructions WHERE conversation_id=?").get(id) as {messages_json: string} | undefined;
  return row ? JSON.parse(row.messages_json) : [];
}

/** Search only local history owned by this account; never initiates upstream sync. */
export function searchConversations(accountId: string, query: string): StoredConversation[] {
  const rows = db.prepare(`SELECT c.* FROM conversations c WHERE account_id = ? AND
    (instr(lower(title), lower(?)) > 0 OR EXISTS
      (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND instr(lower(m.content), lower(?)) > 0))
    ORDER BY updated_at DESC LIMIT 100`).all(accountId, query, query) as Record<string, unknown>[];
  return rows.map(mapConversation);
}

export function relatedConversations(accountId: string, upstreamId: string): StoredConversation[] {
  return (db.prepare("SELECT * FROM conversations WHERE account_id = ? AND upstream_id = ? ORDER BY updated_at DESC")
    .all(accountId, upstreamId) as Record<string, unknown>[]).map(mapConversation);
}
