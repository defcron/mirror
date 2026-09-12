export interface SessionCredentials {
  /** Bearer token minted from the long-lived ChatGPT sessionToken. */
  accessToken: string;
  /** Optional cookie string. The working PoC currently succeeds bearer-only. */
  cookie?: string;
  /** Stable per-install/device UUID sent as oai-device-id. */
  deviceId: string;
  /** Optional Cloudflare Turnstile token for sentinel requirements. */
  turnstileToken?: string | null;
  /** Long-lived session token (cookie value) when available. */
  sessionToken?: string | null;
}

export interface ConversationInitResult {
  defaultModelSlug: string | null;
  intendedDefaultModelSlug: string | null;
  limitsProgress: unknown[];
  blockedFeatures: string[];
  raw: Record<string, unknown>;
}

export interface ModelDescriptor {
  id: string;
  title: string;
  description?: string;
  maxTokens?: number;
  capabilities?: unknown;
  enabledTools?: unknown;
  raw: Record<string, unknown>;
}

export interface GizmoSummary {
  id: string;
  shortUrl?: string;
  name: string;
  description?: string;
  iconUrl?: string;
  filesCount?: number;
  raw: Record<string, unknown>;
}

export interface UploadedFile {
  fileId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  useCase: "multimodal" | "my_files";
  width?: number;
  height?: number;
  raw: Record<string, unknown>;
}

export interface ConversationSessionState {
  conversationId: string | null;
  /** The assistant node that must become parent_message_id on the next turn. */
  currentNodeId: string;
  model: string;
  gizmoId?: string | null;
  initialized?: boolean;
  /** Temporary/incognito chat: excluded from chatgpt.com history and model training. */
  private?: boolean;
}

export interface RemoteConversationSummary {
  id: string;
  title: string;
  createTime: string;
  updateTime: string;
  currentNodeId: string | null;
  gizmoId: string | null;
  isArchived: boolean;
}

export interface PatchEvent {
  p: string;
  o: "add" | "replace" | "remove" | "append" | "patch" | string;
  v: unknown;
  c?: number;
}

export interface ResumeTokenEvent {
  type: "resume_conversation_token";
  kind?: string;
  token: string;
  conversation_id: string;
}

export type StreamEvent =
  | { kind: "protocol_version"; version: string }
  | { kind: "resume_token"; event: ResumeTokenEvent }
  | { kind: "patch"; event: PatchEvent }
  | { kind: "typed"; type: string; raw: Record<string, unknown> }
  | { kind: "unknown"; raw: unknown }
  | { kind: "done" };

/**
 * Stable, application-facing events derived from ChatGPT's compressed patch
 * stream. Raw upstream events are still available so new tool/content types do
 * not disappear merely because Mirror has not learned a pretty renderer yet.
 */
export type NormalizedConversationEvent = {
  /** Retained for diagnostics/continuity, excluded from user-facing rich output. */
  displayHidden?: boolean;
} & (
  | {
      kind: "assistant_text";
      messageId: string | null;
      delta: string;
      text: string;
    }
  | {
      kind: "message";
      messageId: string | null;
      role: string | null;
      contentType: string | null;
      authorName: string | null;
      raw: Record<string, unknown>;
    }
  | {
      kind: "tool";
      messageId: string | null;
      name: string;
      status?: string | null;
      raw: Record<string, unknown>;
    }
  | {
      /** Assistant status narration excluded from the visible answer. Raw
       * messages and related assets also carry displayHidden on this turn. */
      kind: "narration";
      messageId: string | null;
      name: string;
      status?: string | null;
      raw: Record<string, unknown>;
    }
  | {
      kind: "citation";
      fileId?: string;
      title?: string;
      raw: unknown;
    }
  | {
      kind: "image";
      assetPointer: string;
      raw: unknown;
    }
  | {
      kind: "file";
      assetPointer: string;
      title?: string;
      raw: unknown;
    }
  | {
      kind: "marker";
      messageId: string | null;
      marker?: string;
      event?: string;
      raw: Record<string, unknown>;
    }
  | {
      /** Citation data ChatGPT resolves and delivers after the initial
       * answer text (e.g. sidebar/popup reference descriptions), via a
       * dedicated content_references_patch typed event rather than being
       * embedded in the message object itself. Consumers merge this into
       * that message's metadata.content_references. */
      kind: "citation_patch";
      messageId: string | null;
      contentReferences: unknown[];
      raw: Record<string, unknown>;
    }
  | {
      kind: "status";
      messageId: string | null;
      status: string;
    }
  | {
      kind: "raw";
      raw: unknown;
    });

export interface SendMessageResult {
  text: string;
  conversationId: string | null;
  /** Final assistant node, not the outgoing user message UUID. */
  messageId: string | null;
  userMessageId: string;
  status: string | null;
  events: NormalizedConversationEvent[];
}

export class BackendApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "BackendApiError";
  }
}
