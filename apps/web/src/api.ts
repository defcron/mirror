export interface ModelDescriptor { id: string; title: string; description?: string }
export interface GizmoSummary { id: string; name: string; description?: string; iconUrl?: string; filesCount?: number }
export interface UploadedFile {
  fileId: string; fileName: string; fileSize: number; mimeType: string; useCase: "multimodal" | "my_files";
  width?: number; height?: number; raw: Record<string, unknown>;
}
export interface UiEvent {
  kind: "tool" | "citation" | "image" | "file" | "marker" | "status" | string;
  name?: string; status?: string; title?: string; fileId?: string; assetPointer?: string;
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  upstreamNodeId?: string | null;
  events: UiEvent[];
  attachments?: UploadedFile[];
}
export interface Conversation {
  id: string; conversationId: string | null; currentNodeId: string; model: string; gizmoId?: string | null;
  title: string; init?: { blockedFeatures?: string[]; limitsProgress?: unknown[] } | null; createdAt: string; updatedAt: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body as T;
}

export const getSessionStatus = () => json<{ configured: boolean; savedAt: string | null }>("/api/session");
export const saveSession = (sessionToken: string) => json<{ ok: boolean; email?: string | null }>("/api/session", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionToken }),
});
export const clearSession = () => json<{ ok: true }>("/api/session", { method: "DELETE" });
export const getModels = () => json<ModelDescriptor[]>("/api/models");
export const getGpts = () => json<GizmoSummary[]>("/api/gpts");
export const listConversations = () => json<Conversation[]>("/api/conversations");
export const createConversation = (model: string, gizmoId?: string | null) => json<Conversation>("/api/conversations", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, gizmoId }),
});
export const loadConversation = (id: string) => json<{ conversation: Conversation; messages: ChatMessage[] }>(`/api/conversations/${id}`);
export const updateConversationModel = (id: string, model: string) => json<Conversation>(`/api/conversations/${id}`, {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }),
});
export const deleteConversation = (id: string) => json<{ ok: true }>(`/api/conversations/${id}`, { method: "DELETE" });
export const stopConversation = (id: string) => json<{ ok: boolean }>(`/api/conversations/${id}/stop`, { method: "POST" });
export const branchConversation = (id: string, messageId: string, title?: string) => json<Conversation>(`/api/conversations/${id}/branch`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId, title }),
});

export async function uploadFile(file: File): Promise<UploadedFile> {
  const body = new FormData();
  body.append("file", file);
  return json<UploadedFile>("/api/files", { method: "POST", body });
}

export interface StreamChatOptions {
  prompt: string; model: string; conversationId: string | null; gizmoId?: string | null;
  attachments?: UploadedFile[]; signal?: AbortSignal;
  onDelta: (full: string) => void; onEvent: (event: UiEvent) => void;
  onDone: (result: { text: string; conversationId: string; upstreamConversationId: string | null; messageId: string | null; assistantMessageId: string; model: string }) => void;
  onError: (message: string) => void;
}

/** Delta-only SSE consumer. UI commits are coalesced to one update per animation frame. */
export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const response = await fetch("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: opts.signal,
    body: JSON.stringify({
      prompt: opts.prompt, model: opts.model, conversationId: opts.conversationId, gizmoId: opts.gizmoId,
      attachments: opts.attachments ?? [], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffsetMin: -new Date().getTimezoneOffset(),
    }),
  });
  if (!response.ok || !response.body) throw new Error(`Request failed: ${response.status}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let frame = 0;
  const publish = () => { frame = 0; opts.onDelta(full); };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(publish); };
  const flush = () => { if (frame) cancelAnimationFrame(frame); publish(); };

  const processFrame = (raw: string) => {
    const lines = raw.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataText = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!event || !dataText) return;
    const data = JSON.parse(dataText);
    if (event === "delta") { full += String(data.delta ?? ""); schedule(); }
    else if (event === "event") opts.onEvent(data);
    else if (event === "done") { flush(); opts.onDone(data); }
    else if (event === "error") { flush(); opts.onError(String(data.message ?? "Unknown error")); }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    frames.forEach(processFrame);
  }
  buffer += decoder.decode();
  if (buffer.trim()) processFrame(buffer);
  flush();
}
