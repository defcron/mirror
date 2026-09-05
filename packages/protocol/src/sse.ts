/**
 * ChatGPT Web conversation SSE parser/reducer.
 *
 * The stream uses compressed JSON-patch events: p/o may be omitted and inherit
 * the preceding path/op. Typed events (message_marker, input_message,
 * title_generation, tool events, etc.) are interleaved with patch data.
 *
 * Mirror keeps two views simultaneously:
 *   1. a reliable current assistant text + final assistant node for continuity;
 *   2. normalized/raw structured events for tools, file_search, citations,
 *      images and future content types.
 */

import type {
  NormalizedConversationEvent,
  PatchEvent,
  ResumeTokenEvent,
  StreamEvent,
} from "./types.js";

export function* iterSseDataLines(raw: string): Generator<string> {
  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.startsWith("data:")) continue;
    const payload = rawLine.slice("data:".length).trim();
    if (payload.length > 0) yield payload;
  }
}

/** Incrementally frames SSE across arbitrary network chunk and CRLF boundaries. */
export class SseFrameDecoder {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const frames: string[] = [];
    let match: RegExpExecArray | null;
    const boundary = /\r?\n\r?\n/g;
    while ((match = boundary.exec(this.buffer))) {
      frames.push(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match[0].length);
      boundary.lastIndex = 0;
    }
    return frames;
  }

  finish(): string[] {
    const tail = this.buffer.trim();
    this.buffer = "";
    return tail ? [tail] : [];
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function parseSseEvent(
  payload: string,
  inherited: { path: string; op: string },
): StreamEvent {
  if (payload === "[DONE]") return { kind: "done" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "unknown", raw: payload };
  }

  if (typeof parsed === "string") {
    return { kind: "protocol_version", version: parsed };
  }

  if (!isPlainObject(parsed)) {
    return { kind: "unknown", raw: parsed };
  }

  if (parsed.type === "resume_conversation_token") {
    return { kind: "resume_token", event: parsed as unknown as ResumeTokenEvent };
  }

  if (typeof parsed.type === "string") {
    return { kind: "typed", type: parsed.type, raw: parsed };
  }

  if ("v" in parsed) {
    const p = typeof parsed.p === "string" ? parsed.p : inherited.path;
    const o = typeof parsed.o === "string" ? parsed.o : inherited.op;
    const event: PatchEvent = {
      p,
      o,
      v: parsed.v,
      c: typeof parsed.c === "number" ? parsed.c : undefined,
    };
    return { kind: "patch", event };
  }

  return { kind: "unknown", raw: parsed };
}

function roleOf(message: Record<string, unknown>): string | null {
  const author = isPlainObject(message.author) ? message.author : null;
  return author ? asString(author.role) : null;
}

function authorNameOf(message: Record<string, unknown>): string | null {
  const author = isPlainObject(message.author) ? message.author : null;
  return author ? asString(author.name) : null;
}

function contentOf(message: Record<string, unknown>): Record<string, unknown> | null {
  return isPlainObject(message.content) ? message.content : null;
}

function messageText(message: Record<string, unknown>): string {
  const content = contentOf(message);
  const parts = Array.isArray(content?.parts) ? content?.parts : [];
  return typeof parts[0] === "string" ? parts[0] : "";
}

function scanSpecials(
  value: unknown,
  push: (event: NormalizedConversationEvent) => void,
  seen = new Set<unknown>(),
): void {
  if (value === null || value === undefined || seen.has(value)) return;
  if (typeof value === "object") seen.add(value);

  if (typeof value === "string") {
    const matches = value.match(/(?:file-service|sediment):\/\/[^\s"'<>]+/g) ?? [];
    for (const assetPointer of matches) {
      push({ kind: assetPointer.startsWith("sediment://") ? "image" : "file", assetPointer, raw: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) scanSpecials(item, push, seen);
    return;
  }

  if (!isPlainObject(value)) return;

  const assetPointer = asString(value.asset_pointer);
  const contentType = asString(value.content_type);
  if (assetPointer) {
    const title = asString(value.title) ?? asString(value.name) ?? undefined;
    const isImage = contentType === "image_asset_pointer" || contentType?.startsWith("image/") || assetPointer.startsWith("sediment://");
    push({ kind: isImage ? "image" : "file", assetPointer, ...(title ? { title } : {}), raw: value });
  }

  const fileId =
    asString(value.file_id) ??
    asString(value.fileId) ??
    (isPlainObject(value.metadata) ? asString(value.metadata.file_id) : null);
  const title =
    asString(value.title) ??
    asString(value.name) ??
    (isPlainObject(value.metadata) ? asString(value.metadata.title) : null);
  const looksLikeCitation =
    contentType?.includes("citation") ||
    "citation" in value ||
    "citations" in value ||
    "file_citation" in value;
  if (looksLikeCitation) {
    push({
      kind: "citation",
      ...(fileId ? { fileId } : {}),
      ...(title ? { title } : {}),
      raw: value,
    });
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key !== "asset_pointer") scanSpecials(nested, push, seen);
  }
}

export class ConversationStreamReducer {
  private lastPath = "";
  private lastOp = "";
  private currentMessage: Record<string, unknown> | null = null;
  private currentMessageId: string | null = null;
  private currentAssistantId: string | null = null;
  private assistantTexts = new Map<string, string>();
  private conversationId: string | null = null;
  private resumeToken: string | null = null;
  private finished = false;
  private errorCode: string | null = null;
  private finalAssistantId: string | null = null;
  private normalized: NormalizedConversationEvent[] = [];

  feed(payload: string): StreamEvent {
    const event = parseSseEvent(payload, {
      path: this.lastPath,
      op: this.lastOp,
    });
    this.apply(event);
    return event;
  }

  drainEvents(): NormalizedConversationEvent[] {
    const out = this.normalized;
    this.normalized = [];
    return out;
  }

  private push(event: NormalizedConversationEvent): void {
    this.normalized.push(event);
  }

  private apply(event: StreamEvent): void {
    if (event.kind === "done") {
      this.finished = true;
      return;
    }

    if (event.kind === "resume_token") {
      this.resumeToken = event.event.token;
      this.conversationId = event.event.conversation_id;
      return;
    }

    if (event.kind === "typed") {
      this.applyTyped(event.type, event.raw);
      scanSpecials(event.raw, (normalized) => this.push(normalized));
      return;
    }

    if (event.kind === "unknown") {
      this.push({ kind: "raw", raw: event.raw });
      scanSpecials(event.raw, (normalized) => this.push(normalized));
      return;
    }

    if (event.kind !== "patch") return;

    const { p, o, v } = event.event;
    this.lastPath = p;
    this.lastOp = o;

    if (o === "patch" && Array.isArray(v)) {
      for (const sub of v) {
        if (
          isPlainObject(sub) &&
          typeof sub.p === "string" &&
          typeof sub.o === "string"
        ) {
          this.applyOp(sub.p, sub.o, sub.v);
          scanSpecials(sub, (normalized) => this.push(normalized));
        }
      }
      return;
    }

    this.applyOp(p, o, v);
    scanSpecials(v, (normalized) => this.push(normalized));
  }

  private applyTyped(type: string, raw: Record<string, unknown>): void {
    if (type === "message_marker") {
      const messageId = asString(raw.message_id);
      const marker = asString(raw.marker);
      const event = asString(raw.event);
      this.push({
        kind: "marker",
        messageId,
        ...(marker ? { marker } : {}),
        ...(event ? { event } : {}),
        raw,
      });

      // This is the exact continuity marker observed in current ChatGPT Web.
      if (
        messageId &&
        event === "last" &&
        (marker === "last_token" || marker === null)
      ) {
        this.finalAssistantId = messageId;
      }
      return;
    }

    // Tool-call/status typed events vary over time. Preserve them and promote
    // obvious tool names into a stable event.
    const toolName =
      asString(raw.tool_name) ??
      asString(raw.name) ??
      (type.includes("tool") ? type : null);
    if (toolName) {
      this.push({
        kind: "tool",
        messageId: asString(raw.message_id),
        name: toolName,
        status: asString(raw.status),
        raw,
      });
    } else {
      this.push({ kind: "raw", raw });
    }
  }

  private setCurrentMessage(message: Record<string, unknown>): void {
    this.currentMessage = message;
    this.currentMessageId = asString(message.id);

    const role = roleOf(message);
    const content = contentOf(message);
    const contentType = content ? asString(content.content_type) : null;
    const authorName = authorNameOf(message);

    this.push({
      kind: "message",
      messageId: this.currentMessageId,
      role,
      contentType,
      authorName,
      raw: message,
    });

    if (role === "assistant" && this.currentMessageId) {
      this.currentAssistantId = this.currentMessageId;
      this.assistantTexts.set(this.currentMessageId, messageText(message));
      if (messageText(message)) this.push({kind: "assistant_text", messageId: this.currentMessageId, delta: messageText(message), text: messageText(message)});
    }

    const isTool =
      role === "tool" ||
      Boolean(authorName) ||
      contentType === "computer_initialize_state" ||
      contentType === "computer_output";
    if (isTool) {
      this.push({
        kind: "tool",
        messageId: this.currentMessageId,
        name: authorName ?? contentType ?? "tool",
        status: asString(message.status),
        raw: message,
      });
    }
  }

  private applyOp(path: string, op: string, value: unknown): void {
    if (
      path === "" &&
      (op === "add" || op === "replace") &&
      isPlainObject(value)
    ) {
      if (isPlainObject(value.message)) {
        this.setCurrentMessage(value.message);
      }
      if (typeof value.conversation_id === "string") {
        this.conversationId = value.conversation_id;
      }
      if (typeof value.error_code === "string") {
        this.errorCode = value.error_code;
      }
      return;
    }

    if (path === "/message/id" && this.currentMessage) {
      if (typeof value === "string") {
        this.currentMessage.id = value;
        this.currentMessageId = value;
        if (roleOf(this.currentMessage) === "assistant") {
          this.currentAssistantId = value;
          this.assistantTexts.set(value, messageText(this.currentMessage));
        }
      }
      return;
    }

    if (
      (path === "/message/content/parts/0" ||
        path.startsWith("/message/content/parts/0/")) &&
      this.currentMessage
    ) {
      const content = contentOf(this.currentMessage);
      const parts = Array.isArray(content?.parts) ? content?.parts : null;
      if (parts && path === "/message/content/parts/0") {
        const before = typeof parts[0] === "string" ? parts[0] : "";
        const next =
          op === "append"
            ? before + String(value)
            : op === "remove"
              ? ""
              : String(value);
        parts[0] = next;

        if (
          roleOf(this.currentMessage) === "assistant" &&
          this.currentMessageId
        ) {
          this.currentAssistantId = this.currentMessageId;
          this.assistantTexts.set(this.currentMessageId, next);
          const delta =
            op === "append"
              ? String(value)
              : next.startsWith(before)
                ? next.slice(before.length)
                : next;
          this.push({
            kind: "assistant_text",
            messageId: this.currentMessageId,
            delta,
            text: next,
          });
        }
      }
      return;
    }

    if (
      path === "/message/status" &&
      this.currentMessage &&
      typeof value === "string"
    ) {
      this.currentMessage.status = value;
      this.push({
        kind: "status",
        messageId: this.currentMessageId,
        status: value,
      });
      if (
        value === "finished_successfully" &&
        roleOf(this.currentMessage) === "assistant" &&
        this.currentMessageId
      ) {
        this.finalAssistantId ??= this.currentMessageId;
      }
    }
  }

  get text(): string {
    if (!this.currentAssistantId) return "";
    return this.assistantTexts.get(this.currentAssistantId) ?? "";
  }

  get role(): string | null {
    return this.currentMessage ? roleOf(this.currentMessage) : null;
  }

  get status(): string | null {
    return this.currentMessage && typeof this.currentMessage.status === "string"
      ? this.currentMessage.status
      : null;
  }

  get isDone(): boolean {
    return this.finished;
  }

  get conversationIdValue(): string | null {
    return this.conversationId;
  }

  get currentAssistantMessageId(): string | null {
    return this.finalAssistantId ?? this.currentAssistantId;
  }

  get error(): string | null {
    return this.errorCode;
  }
}
