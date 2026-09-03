import {
  ChatGptBackendClient,
  type ConversationInitResult,
  type NormalizedConversationEvent,
  type SendMessageResult,
  type UploadedFile,
} from "@mirror/protocol";
import { getValidCredentials } from "./auth.js";
import {
  addMessage,
  createConversation,
  getConversation,
  getSession,
  updateConversation,
  updateMessage,
  deleteConversation,
  type StoredConversation,
} from "./store.js";

const activeTurns = new Map<string, AbortController>();

export interface RunChatOptions {
  conversationId?: string | null;
  /** When creating a brand-new conversation (no conversationId given/found), use this as its id instead of a random one - lets an API caller pick their own conversation id up front. */
  newConversationId?: string;
  prompt: string;
  model?: string;
  gizmoId?: string | null;
  timezone?: string;
  timezoneOffsetMin?: number;
  attachments?: UploadedFile[];
  /** Temporary/incognito chat: excluded from chatgpt.com history and model training. */
  private?: boolean;
  /** Do not retain locally and force upstream temporary-chat semantics. */
  ephemeral?: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onEvent?: (event: NormalizedConversationEvent) => void;
}

function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  return oneLine.length > 54
    ? `${oneLine.slice(0, 53)}…`
    : oneLine || "New chat";
}

function linkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(signal.reason);
  else
    signal?.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  return controller;
}

export async function runChat(
  opts: RunChatOptions,
): Promise<{
  conversation: StoredConversation;
  result: SendMessageResult;
  storedAssistantMessageId: string;
}> {
  const conversation = opts.conversationId
    ? getConversation(opts.conversationId)
    : createConversation({
        id: opts.newConversationId,
        model: opts.model ?? "auto",
        gizmoId: opts.gizmoId,
        private: opts.private || opts.ephemeral,
        title: titleFromPrompt(opts.prompt),
        accountId: getSession()?.accountId ?? "default",
      });
  if (!conversation)
    throw Object.assign(new Error("Conversation not found"), {
      statusCode: 404,
    });
  if (conversation.accountId !== (getSession()?.accountId ?? "default"))
    throw Object.assign(new Error("Conversation not found"), {
      statusCode: 404,
    });
  if (activeTurns.has(conversation.id))
    throw Object.assign(
      new Error("A response is already running for this conversation"),
      { statusCode: 409 },
    );

  const controller = linkedAbortController(opts.signal);
  activeTurns.set(conversation.id, controller);
  const user = addMessage({
    conversationId: conversation.id,
    upstreamNodeId: null,
    role: "user",
    content: opts.prompt,
    status: "done",
    events: [],
    attachments: opts.attachments,
  });
  const assistant = addMessage({
    conversationId: conversation.id,
    upstreamNodeId: null,
    role: "assistant",
    content: "",
    status: "streaming",
    events: [],
  });

  let fullText = "";
  const events: NormalizedConversationEvent[] = [];
  try {
    const creds = await getValidCredentials();
    const client = new ChatGptBackendClient(creds);
    await client.fetchMe(controller.signal).catch(() => undefined);

    let init: ConversationInitResult | null = null;
    if (!conversation.initialized) {
      init = await client.initConversation(
        {
          timezone: opts.timezone ?? "UTC",
          timezoneOffsetMin: opts.timezoneOffsetMin ?? 0,
          gizmoId: conversation.gizmoId,
          requestedModel:
            conversation.model === "auto" ? null : conversation.model,
          conversationId: conversation.conversationId,
          historyAndTrainingDisabled: conversation.private,
        },
        controller.signal,
      );
      if (conversation.model === "auto") {
        conversation.model =
          init.defaultModelSlug ??
          init.intendedDefaultModelSlug ??
          conversation.model;
      }
      conversation.initialized = true;
      conversation.init = {
        defaultModelSlug: init.defaultModelSlug,
        intendedDefaultModelSlug: init.intendedDefaultModelSlug,
        limitsProgress: init.limitsProgress,
        blockedFeatures: init.blockedFeatures,
      };
      updateConversation(conversation);
    }

    const gizmoPayload =
      conversation.gizmoId && !conversation.conversationId
        ? await client
            .fetchGizmo(conversation.gizmoId, controller.signal)
            .catch(() => null)
        : null;
    const result = await client.sendMessage({
      prompt: opts.prompt,
      model: conversation.model,
      conversationId: conversation.conversationId,
      parentMessageId: conversation.currentNodeId,
      gizmoId: conversation.gizmoId,
      gizmoPayload,
      timezone: opts.timezone,
      timezoneOffsetMin: opts.timezoneOffsetMin,
      attachments: opts.attachments,
      historyAndTrainingDisabled: conversation.private,
      signal: controller.signal,
      onDelta: (delta, full) => {
        fullText = full;
        opts.onDelta?.(delta);
      },
      onEvent: (event) => {
        events.push(event);
        opts.onEvent?.(event);
      },
    });

    conversation.conversationId = result.conversationId;
    if (result.messageId) conversation.currentNodeId = result.messageId;
    updateConversation(conversation);
    updateMessage(user.id, user.content, "done", result.userMessageId, []);
    updateMessage(
      assistant.id,
      result.text || fullText,
      result.status ?? "done",
      result.messageId,
      events,
    );
    return {
      conversation: getConversation(conversation.id)!,
      result,
      storedAssistantMessageId: assistant.id,
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Generation stopped"
        : "Generation failed";
    updateMessage(
      assistant.id,
      fullText,
      message === "Generation stopped" ? "stopped" : "error",
      null,
      events,
    );
    throw error;
  } finally {
    activeTurns.delete(conversation.id);
    if (opts.ephemeral) deleteConversation(conversation.id);
  }
}

export function stopConversation(id: string): boolean {
  const controller = activeTurns.get(id);
  if (!controller) return false;
  controller.abort(new DOMException("Stopped by user", "AbortError"));
  return true;
}
