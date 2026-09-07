/**
 * Current ChatGPT Web backend client.
 *
 * This package contains wire-protocol behavior only. Product concerns
 * (persistence, OpenAI compatibility, UI, multi-user policy) stay outside.
 */

import { randomUUID } from "node:crypto";
import { decodeProofConfig, generateProofTokenInWorker } from "./proof.js";
import {
  ConversationStreamReducer,
  iterSseDataLines,
  SseFrameDecoder,
} from "./sse.js";
import {
  BackendApiError,
  type ConversationInitResult,
  type ConversationSessionState,
  type NormalizedConversationEvent,
  type SendMessageResult,
  type SessionCredentials,
  type UploadedFile,
  type RemoteConversationSummary,
} from "./types.js";

const ORIGIN = "https://chatgpt.com";
const BASE_URL = `${ORIGIN}/backend-api`;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function modeFor(
  gizmoId: string | null | undefined,
  gizmoPayload?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!gizmoId) return { kind: "primary_assistant" };
  return {
    kind: "gizmo_interaction",
    gizmo_id: gizmoId,
    ...(gizmoPayload ? { gizmo: gizmoPayload } : {}),
  };
}

function commonContext() {
  return {
    system_hints: [],
    model_response_contracts: [
      {
        id: "photo_upload_action.v1",
        protocol_version: 1,
        presets: ["cap:image", "cap:file", "placement:end"],
      },
    ],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      app_name: "chatgpt.com",
      has_web_push_capabilities: false,
      web_push_notification_permission: "default",
    },
    local_function_names: ["local.continue_in_work"],
  };
}

export interface SendMessageOptions {
  prompt: string;
  model: string;
  conversationId?: string | null;
  parentMessageId?: string;
  timezone?: string;
  timezoneOffsetMin?: number;
  gizmoId?: string | null;
  /** Full current /gizmos/<id> response; sent only on the first gizmo turn. */
  gizmoPayload?: Record<string, unknown> | null;
  attachments?: UploadedFile[];
  /** Temporary/incognito chat: excluded from chatgpt.com history and model training. */
  historyAndTrainingDisabled?: boolean;
  onDelta?: (text: string, full: string) => void;
  onEvent?: (event: NormalizedConversationEvent) => void;
  signal?: AbortSignal;
}

export interface UploadFileOptions {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

export class ChatGptBackendClient {
  public accountId: string | null = null;

  constructor(private readonly creds: SessionCredentials) {}

  private commonHeaders(
    path: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      authorization: `Bearer ${this.creds.accessToken}`,
      ...(this.creds.cookie ? { cookie: this.creds.cookie } : {}),
      "content-type": "application/json",
      "oai-device-id": this.creds.deviceId,
      "oai-language": "en-US",
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "user-agent": USER_AGENT,
      "x-openai-target-path": `/backend-api${path}`,
      "x-openai-target-route": `/backend-api${path}`,
      ...extra,
    };
  }

  private async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: this.commonHeaders(path, opts.headers),
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: opts.signal,
    });
    return res;
  }

  private async getJson(
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await this.request("GET", path, { signal });
    const text = await res.text();
    const json = safeJson(text);
    if (!res.ok) {
      throw new BackendApiError(
        `GET ${path} failed: ${res.status}`,
        res.status,
        json ?? text,
      );
    }
    if (!isObject(json)) {
      throw new BackendApiError(`GET ${path} returned non-object JSON`);
    }
    return json;
  }

  private async postJson(
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const res = await this.request("POST", path, {
      body,
      headers: extraHeaders,
      signal,
    });
    const text = await res.text();
    const json = safeJson(text);
    if (!res.ok) {
      throw new BackendApiError(
        `POST ${path} failed: ${res.status}`,
        res.status,
        json ?? text,
      );
    }
    if (!isObject(json)) {
      throw new BackendApiError(`POST ${path} returned non-object JSON`);
    }
    return json;
  }

  async fetchMe(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const json = await this.getJson("/me", signal);
    const account = isObject(json.account) ? json.account : null;
    const orgs = isObject(json.orgs) && Array.isArray(json.orgs.data)
      ? json.orgs.data
      : [];
    if (account && typeof account.account_user_id === "string") {
      this.accountId = account.account_user_id;
    } else if (
      orgs.length > 0 &&
      isObject(orgs[0]) &&
      typeof orgs[0].id === "string"
    ) {
      this.accountId = orgs[0].id;
    }
    return json;
  }

  async fetchModels(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.getJson(
      "/models?iim=false&is_gizmo=false&supports_model_picker_upgrade_presets=true",
      signal,
    );
  }

  async fetchGptModels(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.getJson("/models/gpts", signal);
  }

  async fetchGizmoSidebar(
    opts: { limit?: number; ownedOnly?: boolean; conversationsPerGizmo?: number } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      owned_only: String(opts.ownedOnly ?? true),
      conversations_per_gizmo: String(opts.conversationsPerGizmo ?? 5),
      limit: String(opts.limit ?? 50),
    });
    return this.getJson(`/gizmos/snorlax/sidebar?${params}`, signal);
  }

  /**
   * Actual Custom GPTs (owned + pinned in the sidebar), as opposed to
   * `/gizmos/snorlax/sidebar` above which - despite the shared "gizmos/"
   * path prefix - only surfaces ChatGPT Projects ("snorlax"), never GPTs.
   * Upstream caps `limit` at 20 and exposes no pagination cursor.
   */
  async fetchGizmoBootstrap(
    opts: { limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({ limit: String(Math.min(opts.limit ?? 20, 20)) });
    return this.getJson(`/gizmos/bootstrap?${params}`, signal);
  }

  async fetchGizmo(
    idOrSlug: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.getJson(`/gizmos/${encodeURIComponent(idOrSlug)}`, signal);
  }

  async fetchConversations(
    opts: { offset?: number; limit?: number; archived?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<{ items: RemoteConversationSummary[]; total: number }> {
    const params = new URLSearchParams({
      offset: String(opts.offset ?? 0), limit: String(opts.limit ?? 100), order: "updated",
      is_archived: String(opts.archived ?? false),
    });
    const raw = await this.getJson(`/conversations?${params}`, signal);
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
      items: items.filter(isObject).flatMap((item) => {
        if (typeof item.id !== "string") return [];
        return [{
          id: item.id,
          title: typeof item.title === "string" ? item.title : "New chat",
          createTime: String(item.create_time ?? new Date().toISOString()),
          updateTime: String(item.update_time ?? item.create_time ?? new Date().toISOString()),
          currentNodeId: typeof item.current_node === "string" ? item.current_node : null,
          gizmoId: typeof item.gizmo_id === "string" ? item.gizmo_id : null,
          isArchived: item.is_archived === true,
        }];
      }),
      total: typeof raw.total === "number" ? raw.total : items.length,
    };
  }

  async fetchConversation(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.getJson(`/conversation/${encodeURIComponent(id)}`, signal);
  }

  async initConversation(
    opts: {
      timezone: string;
      timezoneOffsetMin: number;
      gizmoId?: string | null;
      requestedModel?: string | null;
      conversationId?: string | null;
      /** Temporary/incognito chat: excluded from chatgpt.com history and model training. */
      historyAndTrainingDisabled?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ConversationInitResult> {
    const raw = await this.postJson(
      "/conversation/init",
      {
        requested_default_model: opts.requestedModel ?? null,
        conversation_id: opts.conversationId ?? null,
        timezone: opts.timezone,
        timezone_offset_min: opts.timezoneOffsetMin,
        conversation_origin: null,
        ...(opts.gizmoId ? { gizmo_id: opts.gizmoId } : {}),
        ...(opts.historyAndTrainingDisabled ? { history_and_training_disabled: true } : {}),
      },
      {},
      signal,
    );

    const limits = Array.isArray(raw.limits_progress)
      ? raw.limits_progress
      : [];
    const blocked = Array.isArray(raw.blocked_features)
      ? raw.blocked_features.filter((v): v is string => typeof v === "string")
      : [];

    return {
      defaultModelSlug:
        typeof raw.default_model_slug === "string"
          ? raw.default_model_slug
          : null,
      intendedDefaultModelSlug:
        typeof raw.intended_default_model_slug === "string"
          ? raw.intended_default_model_slug
          : null,
      limitsProgress: limits,
      blockedFeatures: blocked,
      raw,
    };
  }

  /**
   * Current follow-up flow observed in September 2026:
   * context-change prepare -> conduit A -> composer-state prepare -> conduit B.
   */
  private async prepareFollowup(opts: {
    model: string;
    conversationId: string;
    parentMessageId: string;
    prompt: string;
    timezone: string;
    timezoneOffsetMin: number;
    gizmoId?: string | null;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const common = {
      action: "next",
      conversation_id: opts.conversationId,
      parent_message_id: opts.parentMessageId,
      model: opts.model,
      timezone_offset_min: opts.timezoneOffsetMin,
      timezone: opts.timezone,
      conversation_mode: modeFor(opts.gizmoId),
      ...commonContext(),
    };

    let first: Record<string, unknown>;
    try {
      first = await this.postJson(
      "/f/conversation/prepare",
      {
        ...common,
        client_prepare_state: "none",
        client_prepare_dispatch: "immediate",
        client_prepare_source: "context_change",
      },
      {},
      opts.signal,
      );
    } catch (error) {
      if (error instanceof BackendApiError && [400, 404, 409, 422].includes(error.status ?? 0)) return null;
      throw error;
    }
    const conduitA =
      typeof first.conduit_token === "string" ? first.conduit_token : null;

    const userPreviewId = randomUUID();
    try {
      const second = await this.postJson(
        "/f/conversation/prepare",
        {
          ...common,
          client_prepare_state: "success",
          client_prepare_dispatch: "debounced",
          client_prepare_source: "composer_editor_state",
          partial_query: {
            id: userPreviewId,
            author: { role: "user" },
            content: { content_type: "text", parts: [opts.prompt.slice(0, 1)] },
          },
        },
        conduitA ? { "x-conduit-token": conduitA } : {},
        opts.signal,
      );
      return typeof second.conduit_token === "string" ? second.conduit_token : conduitA;
    } catch (error) {
      if (error instanceof BackendApiError && [400, 404, 409, 422].includes(error.status ?? 0)) return conduitA;
      throw error;
    }
  }

  private async sentinelHandshake(signal?: AbortSignal): Promise<{
    chatRequirementsToken: string;
    proofToken: string | null;
    turnstileToken: string;
  }> {
    const prepareRes = await this.postJson(
      "/sentinel/chat-requirements/prepare",
      { p: "" },
      {},
      signal,
    );

    const pow = isObject(prepareRes.proofofwork)
      ? prepareRes.proofofwork
      : {};
    const proofConfig = decodeProofConfig(
      typeof pow.dx === "string" ? pow.dx : null,
    );
    const proofToken = await generateProofTokenInWorker({
      required: Boolean(pow.required),
      seed: typeof pow.seed === "string" ? pow.seed : "",
      difficulty: typeof pow.difficulty === "string" ? pow.difficulty : "",
      userAgent: USER_AGENT,
      proofConfig: Array.isArray(proofConfig)
        ? (proofConfig as any)
        : null,
    }, signal);

    const finalizeRes = await this.postJson(
      "/sentinel/chat-requirements/finalize",
      {
        prepare_token: prepareRes.prepare_token,
        proofofwork: proofToken,
        // The working PoC succeeds with no separately supplied Turnstile token.
        // Keep that behavior until live traffic proves otherwise.
        turnstile: null,
      },
      {},
      signal,
    );

    const token =
      typeof finalizeRes.token === "string" ? finalizeRes.token : null;
    if (!token) {
      throw new BackendApiError(
        "Sentinel finalize succeeded but returned no requirements token",
      );
    }
    return {
      chatRequirementsToken: token,
      proofToken,
      turnstileToken: "",
    };
  }

  async uploadFile(opts: UploadFileOptions): Promise<UploadedFile> {
    const useCase: UploadedFile["useCase"] = opts.mimeType.startsWith("image/")
      ? "multimodal"
      : "my_files";

    const created = await this.postJson(
      "/files",
      {
        file_name: opts.fileName,
        file_size: opts.data.byteLength,
        use_case: useCase,
      },
      {},
      opts.signal,
    );

    const uploadUrl =
      typeof created.upload_url === "string" ? created.upload_url : null;
    const fileId =
      typeof created.file_id === "string" ? created.file_id : null;
    if (!uploadUrl || !fileId) {
      throw new BackendApiError(
        "File create response did not contain upload_url and file_id",
      );
    }

    const upload = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": opts.mimeType,
        origin: ORIGIN,
        "x-ms-blob-type": "BlockBlob",
        "x-ms-version": "2020-04-08",
      },
      body: Buffer.from(opts.data),
      signal: opts.signal,
    });
    if (!upload.ok) {
      throw new BackendApiError(
        `File blob upload failed: ${upload.status}`,
        upload.status,
      );
    }

    const marked = await this.postJson(
      `/files/${encodeURIComponent(fileId)}/uploaded`,
      {},
      {},
      opts.signal,
    );

    return {
      fileId,
      fileName: opts.fileName,
      fileSize: opts.data.byteLength,
      mimeType: opts.mimeType,
      useCase,
      ...(typeof opts.width === "number" ? { width: opts.width } : {}),
      ...(typeof opts.height === "number" ? { height: opts.height } : {}),
      raw: { ...created, ...marked },
    };
  }

  async resolveAssetDownload(
    assetPointer: string,
    conversationId?: string | null,
    signal?: AbortSignal,
  ): Promise<string> {
    let path: string;
    if (assetPointer.startsWith("file-service://")) {
      const id = assetPointer.slice("file-service://".length);
      path = `/files/${encodeURIComponent(id)}/download`;
    } else if (assetPointer.startsWith("sediment://")) {
      const sedimentPointer = assetPointer.slice("sediment://".length);
      const id = sedimentPointer.split("#").find((part) => part.startsWith("file-") || part.startsWith("file_")) ?? sedimentPointer;
      if (!conversationId) {
        throw new BackendApiError(
          "sediment asset download requires conversationId",
        );
      }
      path =
        `/files/download/${encodeURIComponent(id)}` +
        `?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;
    } else {
      throw new BackendApiError("Unsupported asset pointer");
    }

    const json = await this.getJson(path, signal);
    if (typeof json.download_url !== "string") {
      throw new BackendApiError("Asset metadata returned no download_url");
    }
    return json.download_url;
  }

  private buildUserMessage(
    prompt: string,
    attachments: UploadedFile[],
    userMessageId: string,
  ): Record<string, unknown> {
    if (attachments.length === 0) {
      return {
        id: userMessageId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [prompt] },
        metadata: {},
      };
    }

    const parts: unknown[] = attachments.map((file) => ({
      asset_pointer: `file-service://${file.fileId}`,
      size_bytes: file.fileSize,
      ...(typeof file.width === "number" ? { width: file.width } : {}),
      ...(typeof file.height === "number" ? { height: file.height } : {}),
    }));
    parts.push(prompt);

    return {
      id: userMessageId,
      author: { role: "user" },
      create_time: Date.now() / 1000,
      content: { content_type: "multimodal_text", parts },
      metadata: {
        serialization_metadata: { custom_symbol_offsets: [] },
        attachments: attachments.map((file) => ({
          id: file.fileId,
          mimeType: file.mimeType,
          name: file.fileName,
          size: file.fileSize,
          ...(typeof file.width === "number" ? { width: file.width } : {}),
          ...(typeof file.height === "number" ? { height: file.height } : {}),
        })),
      },
    };
  }

  async sendMessage(opts: SendMessageOptions): Promise<SendMessageResult> {
    const timezone = opts.timezone ?? "UTC";
    const timezoneOffsetMin = opts.timezoneOffsetMin ?? 0;
    // Work Mode itself is an asynchronous task protocol, not conversation SSE.
    // Reject unsupported aliases; never silently substitute another model.
    if (opts.model.endsWith("-wm")) throw new BackendApiError("Work Mode is not supported by this transport", 400);
    const interactiveModel = opts.model;
    const firstTurn = !opts.conversationId;
    const parentMessageId = firstTurn
      ? opts.parentMessageId ?? "client-created-root"
      : opts.parentMessageId ?? "client-created-root";

    let conduitToken: string | null = null;
    if (!firstTurn && opts.conversationId) {
      conduitToken = await this.prepareFollowup({
        model: interactiveModel,
        conversationId: opts.conversationId,
        parentMessageId,
        prompt: opts.prompt,
        timezone,
        timezoneOffsetMin,
        gizmoId: opts.gizmoId,
        signal: opts.signal,
      });
    }

    const sentinel = await this.sentinelHandshake(opts.signal);
    const userMessageId = randomUUID();
    const turnTraceId = randomUUID();
    const attachments = opts.attachments ?? [];

    const body: Record<string, unknown> = {
      action: "next",
      messages: [
        this.buildUserMessage(opts.prompt, attachments, userMessageId),
      ],
      parent_message_id: parentMessageId,
      model: interactiveModel,
      client_prepare_state: firstTurn ? "none" : "success",
      timezone_offset_min: timezoneOffsetMin,
      timezone,
      conversation_mode: modeFor(
        opts.gizmoId,
        firstTurn ? opts.gizmoPayload : null,
      ),
      ...(opts.conversationId
        ? { conversation_id: opts.conversationId }
        : {}),
      enable_message_followups: true,
      ...commonContext(),
      paragen_cot_summary_display_override: "allow",
      force_parallel_switch: "auto",
      ...(opts.historyAndTrainingDisabled ? { history_and_training_disabled: true } : {}),
    };

    const res = await this.request("POST", "/f/conversation", {
      body,
      signal: opts.signal,
      headers: {
        ...(this.accountId ? { "chatgpt-account-id": this.accountId } : {}),
        "openai-sentinel-chat-requirements-token":
          sentinel.chatRequirementsToken,
        ...(sentinel.proofToken
          ? { "openai-sentinel-proof-token": sentinel.proofToken }
          : {}),
        "openai-sentinel-turnstile-token": sentinel.turnstileToken,
        "x-oai-turn-trace-id": turnTraceId,
        ...(conduitToken ? { "x-conduit-token": conduitToken } : {}),
        accept: "text/event-stream",
      },
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new BackendApiError(
        `POST /f/conversation failed: ${res.status}`,
        res.status,
        text,
      );
    }

    const reducer = new ConversationStreamReducer();
    const allEvents: NormalizedConversationEvent[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const frames = new SseFrameDecoder();

    const deliver = () => {
      const events = reducer.drainEvents();
      for (const event of events) {
        allEvents.push(event);
        opts.onEvent?.(event);
        if (event.kind === "assistant_text" && event.delta) {
          opts.onDelta?.(event.delta, event.text);
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of frames.push(decoder.decode(value, { stream: true }))) {
          for (const payload of iterSseDataLines(chunk)) {
            reducer.feed(payload);
            deliver();
            if (reducer.isDone) break;
          }
        }
        if (reducer.isDone) break;
      }
    } finally {
      if (reducer.isDone) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }

    // Flushing UTF-8 emits only a pending replacement character, never an
    // SSE delimiter. The unterminated final frame is handled by finish().
    frames.push(decoder.decode());
    for (const chunk of frames.finish()) {
      for (const payload of iterSseDataLines(chunk)) {
        reducer.feed(payload);
        deliver();
      }
    }
    deliver();

    if (!reducer.isDone) throw new BackendApiError("Conversation stream interrupted before completion");

    if (reducer.error) {
      throw new BackendApiError(
        `Conversation stream returned error_code=${reducer.error}`,
      );
    }

    return {
      text: reducer.text,
      conversationId: reducer.conversationIdValue,
      messageId: reducer.currentAssistantMessageId,
      userMessageId,
      status: reducer.status,
      events: allEvents,
    };
  }

  /**
   * A stateful convenience wrapper. Server-side persistence can serialize
   * `state` between requests instead of depending on an in-memory object.
   */
  conversation(
    state: ConversationSessionState,
    gizmoPayload?: Record<string, unknown> | null,
  ): ChatGptConversationSession {
    return new ChatGptConversationSession(this, state, gizmoPayload);
  }
}

export class ChatGptConversationSession {
  constructor(
    private readonly client: ChatGptBackendClient,
    public readonly state: ConversationSessionState,
    private gizmoPayload: Record<string, unknown> | null = null,
  ) {}

  async initialize(
    timezone: string,
    timezoneOffsetMin: number,
    signal?: AbortSignal,
  ): Promise<ConversationInitResult> {
    const init = await this.client.initConversation(
      {
        timezone,
        timezoneOffsetMin,
        gizmoId: this.state.gizmoId,
        requestedModel:
          this.state.model === "auto" ? null : this.state.model,
        conversationId: this.state.conversationId,
      },
      signal,
    );
    const selectedModel = init.defaultModelSlug ?? init.intendedDefaultModelSlug;
    if (this.state.model === "auto" && selectedModel) this.state.model = selectedModel;
    this.state.initialized = true;
    return init;
  }

  async send(
    prompt: string,
    opts: Omit<
      SendMessageOptions,
      | "prompt"
      | "model"
      | "conversationId"
      | "parentMessageId"
      | "gizmoId"
      | "gizmoPayload"
    > = {},
  ): Promise<SendMessageResult> {
    if (!this.state.initialized) {
      await this.initialize(
        opts.timezone ?? "UTC",
        opts.timezoneOffsetMin ?? 0,
        opts.signal,
      );
    }

    const result = await this.client.sendMessage({
      ...opts,
      prompt,
      model: this.state.model,
      conversationId: this.state.conversationId,
      parentMessageId: this.state.currentNodeId,
      gizmoId: this.state.gizmoId,
      gizmoPayload: this.gizmoPayload,
    });

    if (result.conversationId) {
      this.state.conversationId = result.conversationId;
    }
    if (result.messageId) {
      this.state.currentNodeId = result.messageId;
    }
    // Full gizmo bootstrap belongs on the first turn only.
    this.gizmoPayload = null;
    return result;
  }
}

export function newDeviceId(): string {
  return randomUUID();
}
