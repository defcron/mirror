import { readCompletionStream } from "./completion-stream.js";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  editPlaygroundMessage,
  removePlaygroundMessage,
  type PlaygroundMessage,
} from "./playground-history.js";

interface ApiModel {
  id: string;
  owned_by?: string;
  mirror?: {supported: boolean};
  name?: string;
}
interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  gizmoId?: string | null;
  updatedAt: string;
}
interface StoredMessageDto {
  role: "user" | "assistant";
  content: string;
}

const DEFAULT_MESSAGES: PlaygroundMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Say hello in one short sentence." },
];
const STORAGE_KEY_CONVERSATION_ID = "mirror-playground-conversation-id";
const STORAGE_KEY_MESSAGES = "mirror-playground-messages";
const STORAGE_KEY_REMEMBER = "mirror-playground-remember-history";
const CONVERSATIONS_PAGE_SIZE = 50;

function loadSnapshot(): { model: string; pickedModel: string; privateChat: boolean } | null {
  try { return localStorage.getItem(STORAGE_KEY_REMEMBER) === "true" ? JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null") : null; } catch { return null; }
}
function loadStoredConversationId(): string {
  try {
    if (localStorage.getItem(STORAGE_KEY_REMEMBER) !== "true") return "";
    const snapshot = JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null");
    return snapshot?.conversationId ?? "";
  } catch {
    return "";
  }
}
function loadStoredMessages(): PlaygroundMessage[] {
  try {
    if (localStorage.getItem(STORAGE_KEY_REMEMBER) !== "true")
      return DEFAULT_MESSAGES;
    const raw = JSON.stringify(JSON.parse(localStorage.getItem("mirror-playground-snapshot") ?? "null")?.messages ?? null);
    const parsed = raw ? JSON.parse(raw) : null;
    if (
      Array.isArray(parsed) &&
      parsed.length &&
      parsed.every(
        (item) =>
          item &&
          ["system", "developer", "user", "assistant"].includes(item.role) &&
          typeof item.content === "string",
      )
    )
      return parsed;
  } catch {
    /* fall through to defaults */
  }
  return DEFAULT_MESSAGES;
}

function Header() {
  return (
    <header className="platform-header">
      <a className="platform-brand" href="/">
        <span className="openai-mark">◎</span>
        <b>Mirror API</b>
      </a>
      <nav>
        <a href="/">ChatGPT</a>
        <a className="active" href="/mirror/playground">
          Playground
        </a>
        <a href="/v1/models" target="_blank" rel="noreferrer">
          Models
        </a>
      </nav>
      <div className="environment">Local server</div>
    </header>
  );
}

export default function App() {
  const [domain, setDomain] = useState(() => location.origin);
  const [path, setPath] = useState("/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ApiModel[]>([]);
  const [model, setModel] = useState(() => loadSnapshot()?.model ?? "auto");
  const [modelFreeform, setModelFreeform] = useState(false);
  const [pickedModel, setPickedModel] = useState(() => loadSnapshot()?.pickedModel ?? "");
  const [privateChat, setPrivateChat] = useState(() => loadSnapshot()?.privateChat ?? false);
  const [oneShot, setOneShot] = useState(false);
  // Persisted to localStorage (see effects below) so a page refresh doesn't
  // strand you: the conversation id is exactly what lets you resume an
  // existing upstream conversation, so losing it on refresh defeated the
  // point - every "continue an existing conversation" attempt after a
  // reload silently started a brand-new one instead.
  const [conversationId, setConversationId] = useState<string>(
    loadStoredConversationId,
  );
  const [stream, setStream] = useState(true);
  const [rememberHistory, setRememberHistory] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY_REMEMBER) === "true";
    } catch {
      return false;
    }
  });
  const [messages, setMessages] =
    useState<PlaygroundMessage[]>(loadStoredMessages);
  const [conversationsList, setConversationsList] = useState<
    ConversationSummary[]
  >([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsLoadingMore, setConversationsLoadingMore] =
    useState(false);
  const [conversationsOffset, setConversationsOffset] = useState(0);
  const [conversationsHasMore, setConversationsHasMore] = useState(false);
  const [output, setOutput] = useState("");
  const [raw, setRaw] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [controller, setController] = useState<AbortController | null>(null);
  const endpoint = useMemo(
    () =>
      `${domain.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    [domain, path],
  );
  useEffect(() => {
    try {
      localStorage.removeItem(STORAGE_KEY_CONVERSATION_ID);
      localStorage.removeItem(STORAGE_KEY_MESSAGES);
      localStorage.setItem(STORAGE_KEY_REMEMBER, String(rememberHistory));
      if (rememberHistory && !oneShot && !running) localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId, messages, model, pickedModel, privateChat }));
      else if (!rememberHistory || oneShot) localStorage.removeItem("mirror-playground-snapshot");
    } catch { /* Storage may be unavailable. */ }
  }, [conversationId, messages, model, pickedModel, privateChat, rememberHistory, oneShot, running]);
  const isGizmoModel = /^g-/.test(model);
  const lastMessage = messages.at(-1);
  // Not used to disable the Run button (that turned out to trap people who
  // typed into the freshly-appended row and still saw it stay disabled) -
  // only to show *why* a click was a no-op, via runBlockedReason below.
  const canRun = Boolean(
    lastMessage && lastMessage.role === "user" && lastMessage.content.trim(),
  );
  const runBlockedReason =
    !lastMessage || lastMessage.role !== "user"
      ? "The last message must be from the user."
      : !lastMessage.content.trim()
        ? "Type a message in the last (user) row before running."
        : null;

  useEffect(() => {
    fetch(`${domain.replace(/\/$/, "")}/v1/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} })
      .then(async (res) => { if (!res.ok) throw new Error(`Model discovery failed: ${res.status}`); return res.json(); })
      .then((body) => {
        if (Array.isArray(body.data)) setModels(body.data);
      })
      .catch(() => undefined);
  }, [domain, apiKey]);

  // sync is always sent - the server only pulls however many more upstream
  // pages are needed to cover this request's window, resuming from a
  // persisted cursor (see index.ts), so it's cheap on every call rather
  // than something to gate behind a special "first load only" flag. resync
  // is the expensive one: it restarts that cursor from the top, so it's
  // reserved for an explicit user-initiated refresh.
  async function fetchConversationsPage(offset: number, resync: boolean) {
    const params = new URLSearchParams({
      limit: String(CONVERSATIONS_PAGE_SIZE),
      offset: String(offset),
      sync: "true",
      resync: String(resync),
    });
    const res = await fetch(`${location.origin}/api/conversations?${params}`);
    const body = await res.json();
    return {
      items: Array.isArray(body.items) ? (body.items as ConversationSummary[]) : [],
      hasMore: Boolean(body.hasMore),
    };
  }
  // Used on mount, after every completed run (a run can create/reorder a
  // conversation), and by the explicit Refresh button (resync=true there -
  // see the button below).
  async function refreshConversations(resync = false) {
    setConversationsLoading(true);
    try {
      const { items, hasMore } = await fetchConversationsPage(0, resync);
      setConversationsList(items);
      setConversationsOffset(items.length);
      setConversationsHasMore(hasMore);
    } catch {
      /* best-effort - the picker just stays empty/stale */
    } finally {
      setConversationsLoading(false);
    }
  }
  const loadingMoreRef = useRef(false);
  async function loadMoreConversations() {
    if (loadingMoreRef.current || !conversationsHasMore) return;
    loadingMoreRef.current = true;
    setConversationsLoadingMore(true);
    try {
      const { items, hasMore } = await fetchConversationsPage(
        conversationsOffset,
        false,
      );
      setConversationsList((current) => [...current, ...items]);
      setConversationsOffset((current) => current + items.length);
      setConversationsHasMore(hasMore);
    } catch {
      /* best-effort - scrolling again will just retry */
    } finally {
      loadingMoreRef.current = false;
      setConversationsLoadingMore(false);
    }
  }
  useEffect(() => {
    void refreshConversations();
  }, []);

  async function loadConversation(id: string) {
    if (!id) return;
    setStatus("Loading…");
    try {
      const res = await fetch(
        `${location.origin}/api/conversations/${encodeURIComponent(id)}`,
      );
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const body = await res.json();
      const loaded: StoredMessageDto[] = Array.isArray(body.messages)
        ? body.messages
        : [];
      // The stored history only ever has user/assistant turns (see
      // store.ts) - a leading system/developer message isn't tracked as a
      // "message" server-side, so keep whatever the editor currently has
      // (or fall back to the default) rather than dropping it.
      const savedInstructions = Array.isArray(body.instructions) ? body.instructions : [];
      setMessages([
        ...savedInstructions,
        ...loaded.map((m) => ({ role: m.role, content: m.content })),
        { role: "user" as const, content: "" },
      ]);
      setConversationId(body.conversation?.id ?? id);
      setPickedModel(body.conversation?.gizmoId ? body.conversation.model : "");
      if (body.conversation?.gizmoId) setModel(body.conversation.gizmoId);
      else if (body.conversation?.model && body.conversation.model !== "auto")
        setModel(body.conversation.model);
      if (typeof body.conversation?.private === "boolean")
        setPrivateChat(body.conversation.private);
      setStatus("Loaded");
    } catch (error) {
      setStatus("Error");
      setRaw(String((error as Error).message ?? error));
      setShowRaw(true);
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void run();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  function updateMessage(
    index: number,
    key: keyof PlaygroundMessage,
    value: string,
  ) {
    if (runningRef.current) return;
    const mutation = editPlaygroundMessage(
      messages,
      index,
      key,
      value,
      Boolean(conversationId.trim()),
    );
    setMessages(mutation.messages);
  }
  function removeMessage(index: number) {
    if (runningRef.current) return;
    const mutation = removePlaygroundMessage(
      messages,
      index,
      Boolean(conversationId.trim()),
    );
    setMessages(mutation.messages);
  }

  const runningRef = useRef(false);
  async function run() {
    // Belt-and-suspenders against a double-fire (rapid double-click, a stray
    // repeated key event, etc) beating React's state-driven button swap:
    // that used to race two overlapping requests for the same conversation
    // and could leave a sibling reply logged upstream with no user message
    // of its own attached to it.
    if (runningRef.current) return;
    if (!canRun) {
      setStatus("Blocked");
      setRaw(runBlockedReason ?? "Cannot run.");
      setShowRaw(true);
      return;
    }
    runningRef.current = true;
    const abort = new AbortController();
    setController(abort);
    setRunning(true);
    setOutput("");
    setRaw("");
    setStatus("Running…");
    try {
      const metadata: Record<string, string> = {};
      if (privateChat) metadata.private = "true";
      if (isGizmoModel && pickedModel.trim())
        metadata.mirror_model = pickedModel.trim();
      if (conversationId.trim())
        metadata.conversation_id = conversationId.trim();
      const response = await fetch(endpoint, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream,
          store: !oneShot,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        }),
      });
      if (!response.ok)
        throw new Error(`${response.status} ${await response.text()}`);
      const returnedConversationId = response.headers.get(
        "x-mirror-conversation-id",
      );
      if (returnedConversationId) setConversationId(returnedConversationId);
      let finalText = "";
      if (!stream) {
        const body = await response.json();
        setRaw(JSON.stringify(body, null, 2));
        finalText = body.choices?.[0]?.message?.content ?? "";
        setOutput(finalText);
      } else if (response.body) {
        finalText = await readCompletionStream(response.body, setOutput, setRaw, setConversationId);
      } else {
        throw new Error("Response has no stream body");
      }
      // Keep the exact reply in the visible transcript. The conversation id
      // identifies the upstream thread, while the message prefix lets the
      // server verify that the client has not silently diverged from it.
      if (finalText && !oneShot) {
        setMessages((current) => [
          ...current,
          { role: "assistant", content: finalText },
          { role: "user", content: "" },
        ]);
      }
      setStatus("Completed");
      if (!oneShot) void refreshConversations();
    } catch (error) {
      if ((error as Error).name === "AbortError") setStatus("Stopped");
      else {
        setStatus("Error");
        setRaw(String((error as Error).message ?? error));
        setShowRaw(true);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);
      setController(null);
    }
  }

  return (
    <div className="playground-app">
      <Header />
      <aside className="playground-sidebar">
        <div className="side-title">Playground</div>
        <button className="side-item active">
          <span>☷</span> Chat
        </button>
        <button className="side-item" disabled>
          <span>◇</span> Responses
        </button>
        <div className="side-section">Mirror</div>
        <a className="side-item" href="/">
          <span>↗</span> Open ChatGPT
        </a>
        <a
          className="side-item"
          href="/api/health"
          target="_blank"
          rel="noreferrer"
        >
          <span>♥</span> Server health
        </a>
        <div className="server-card">
          <b>Compatible endpoint</b>
          <p>
            Test Mirror or any OpenAI-compatible server directly from your
            browser.
          </p>
        </div>
      </aside>
      <main className="workbench">
        <div className="workbench-head">
          <div>
            <h1>Chat</h1>
            <p>Test an OpenAI-compatible Chat Completions endpoint.</p>
          </div>
          <div className="run-actions">
            <span className={`run-status ${status.toLowerCase()}`}>
              {status}
            </span>
            {running ? (
              <button
                className="stop-button"
                onClick={() => controller?.abort()}
              >
                Stop
              </button>
            ) : (
              <button
                className="run-button"
                title={canRun ? undefined : (runBlockedReason ?? undefined)}
                onClick={() => void run()}
              >
                Run <span>⌘ ↵</span>
              </button>
            )}
          </div>
        </div>
        <div className="connection-bar">
          <label>
            <span>Server domain</span>
            <input
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
            />
          </label>
          <label>
            <span>Path</span>
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
            />
          </label>
          <label>
            <span>Bearer credential</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Optional for this server"
            />
          </label>
        </div>
        <div className="columns">
          <section className="prompt-panel">
            <div className="panel-title">
              <b>Messages</b>
              <button
                disabled={running}
                onClick={() =>
                  setMessages((current) => [
                    ...current,
                    { role: "user", content: "" },
                  ])
                }
              >
                ＋ Add message
              </button>
            </div>
            <div className="messages-editor">
              {messages.map((message, index) => (
                <div className="message-editor" key={index}>
                  <div className="message-toolbar">
                    <select
                      disabled={running || message.role === "assistant"}
                      value={message.role}
                      onChange={(event) =>
                        updateMessage(index, "role", event.target.value)
                      }
                    >
                      <option>system</option>
                      <option>developer</option>
                      <option>user</option>
                      <option>assistant</option>
                    </select>
                    <button
                      aria-label={
                        message.role === "assistant"
                          ? "Assistant messages cannot be removed"
                          : "Remove message"
                      }
                      disabled={running || message.role === "assistant"}
                      onClick={() => removeMessage(index)}
                    >
                      ×
                    </button>
                  </div>
                  <textarea
                    readOnly={running || message.role === "assistant"}
                    aria-readonly={running || message.role === "assistant"}
                    title={
                      message.role === "assistant"
                        ? "Assistant messages are read-only; you can select and copy their text."
                        : undefined
                    }
                    value={message.content}
                    onChange={(event) =>
                      updateMessage(index, "content", event.target.value)
                    }
                  />
                </div>
              ))}
            </div>
          </section>
          <section className="response-panel">
            <div className="response-tabs">
              <button
                className={!showRaw ? "active" : ""}
                onClick={() => setShowRaw(false)}
              >
                Output
              </button>
              <button
                className={showRaw ? "active" : ""}
                onClick={() => setShowRaw(true)}
              >
                Raw response
              </button>
            </div>
            <div
              className={`output ${(showRaw ? raw : output) ? "" : "empty"}`}
            >
              {(showRaw ? raw : output) ||
                "Run the request to see the model response."}
            </div>
          </section>
          <aside className="settings-panel">
            <h2>Configuration</h2>
            <label>
              <span>Model</span>
              <div className="model-picker-row">
                {modelFreeform ? (
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="official model, g-… gizmo id, or g-p-… project id"
                  />
                ) : (
                  <select
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="auto">auto</option>
                    {models.map((item) => (
                      <option value={item.id} key={item.id} disabled={item.mirror?.supported === false}>
                        {item.owned_by === "chatgpt-gizmo"
                          ? `GPT: ${item.name ?? item.id}`
                          : item.owned_by === "chatgpt-project"
                            ? `Project: ${item.name ?? item.id}`
                            : `${item.id}${item.mirror?.supported === false ? " (unsupported)" : ""}`}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="model-mode-toggle"
                  onClick={() => setModelFreeform((current) => !current)}
                >
                  {modelFreeform ? "Use list" : "Type manually"}
                </button>
              </div>
            </label>
            {isGizmoModel && (
              <label>
                <span>Picked model for this GPT/Project</span>
                <input
                  value={pickedModel}
                  onChange={(event) => setPickedModel(event.target.value)}
                  placeholder="e.g. gpt-5-6, or another g-… / g-p-… id (experimental)"
                />
              </label>
            )}
            <label className="switch-line">
              <span>Stream response</span>
              <input
                type="checkbox"
                checked={stream}
                onChange={(event) => setStream(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>Private chat</span>
              <input
                type="checkbox"
                checked={privateChat}
                onChange={(event) => setPrivateChat(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>One-shot (temporary; don't retain)</span>
              <input
                type="checkbox"
                checked={oneShot}
                onChange={(event) => setOneShot(event.target.checked)}
              />
            </label>
            <label className="switch-line">
              <span>Remember prompt history on this device</span>
              <input
                type="checkbox"
                checked={rememberHistory}
                onChange={(event) => setRememberHistory(event.target.checked)}
              />
            </label>
            <label>
              <span>Conversation ID</span>
              <div className="model-picker-row">
                <input
                  disabled={running}
                  value={conversationId}
                  onChange={(event) => setConversationId(event.target.value)}
                  placeholder="auto (filled in after the first response)"
                />
                <button
                  type="button"
                  className="model-mode-toggle"
                  disabled={running}
                  onClick={() => {
                    setConversationId("");
                    setMessages([
                      {
                        role: "system",
                        content: "You are a helpful assistant.",
                      },
                      { role: "user", content: "" },
                    ]);
                  }}
                >
                  New
                </button>
              </div>
            </label>
            <label>
              <div className="conversation-list-head">
                <span>
                  Load a conversation
                  {conversationsLoading ? " (refreshing…)" : ""}
                </span>
                <button
                  type="button"
                  className="model-mode-toggle"
                  onClick={() => void refreshConversations(true)}
                >
                  Refresh
                </button>
              </div>
              <div
                className="conversation-list"
                onScroll={(event) => {
                  const el = event.currentTarget;
                  // Trigger the next page a bit before the user actually
                  // hits bottom, so the fetch has time to land before they
                  // run out of already-rendered rows to scroll through.
                  if (
                    el.scrollTop + el.clientHeight >=
                    el.scrollHeight - 64
                  ) {
                    void loadMoreConversations();
                  }
                }}
              >
                {conversationsList.length === 0 ? (
                  <div className="conversation-list-empty">
                    {conversationsLoading
                      ? "Loading…"
                      : "No conversations yet"}
                  </div>
                ) : (
                  conversationsList.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      disabled={running}
                      className={`conversation-list-item${
                        item.id === conversationId ? " active" : ""
                      }`}
                      onClick={() => void loadConversation(item.id)}
                    >
                      <span className="conversation-list-title">
                        {item.title || "Untitled"}
                      </span>
                      <span className="conversation-list-meta">
                        {new Date(item.updatedAt).toLocaleString()}
                      </span>
                    </button>
                  ))
                )}
                {conversationsLoadingMore && (
                  <div className="conversation-list-loading">
                    Loading more…
                  </div>
                )}
              </div>
              <p className="field-hint">
                Loading a conversation copies its history into the editor
                below. Editing a committed user message
                drops dependent turns; assistant replies are read-only. Run rebases the same Playground
                conversation onto the edited history.
              </p>
            </label>
            <div className="request-preview">
              <span>Request URL</span>
              <code>{endpoint}</code>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
