import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  branchConversation, createConversation, deleteConversation, getGpts, getModels, getSessionStatus,
  listConversations, loadConversation, stopConversation, streamChat, updateConversationModel, uploadFile,
  type ChatMessage, type Conversation, type GizmoSummary, type ModelDescriptor, type UiEvent, type UploadedFile,
} from "./api.js";
import { SettingsModal } from "./SettingsModal.js";

const Markdown = lazy(() => import("./Markdown.js"));

function uid() { return crypto.randomUUID(); }

function Picker({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return <details className="picker"><summary>{value}<span>⌄</span></summary><div className="picker-menu" aria-label={label}>{children}</div></details>;
}

function AssetResult({ event, upstreamConversationId }: { event: UiEvent; upstreamConversationId?: string | null }) {
  const [failed, setFailed] = useState(false);
  const pointer = event.assetPointer!;
  const src = `/api/assets?pointer=${encodeURIComponent(pointer)}${upstreamConversationId ? `&upstreamConversationId=${encodeURIComponent(upstreamConversationId)}` : ""}`;
  if (event.kind === "file" || failed) return <a className="event-chip file" href={src} target="_blank" rel="noreferrer">▧ {event.title ?? "Open file"}</a>;
  return <a className="image-result" href={src} target="_blank" rel="noreferrer"><img src={src} alt={event.title ?? "Generated result"} onError={() => setFailed(true)} /></a>;
}

function EventChips({ events, upstreamConversationId }: { events: UiEvent[]; upstreamConversationId?: string | null }) {
  const useful = [...new Map(events
    .filter((event) => event.kind === "tool" || event.kind === "citation" || event.kind === "file" || (event.kind === "image" && (!event.assetPointer?.startsWith("sediment://") || /#file[-_]/.test(event.assetPointer))))
    .map((event) => [`${event.kind}:${event.assetPointer ?? event.fileId ?? event.name ?? event.title ?? ""}`, event])).values()];
  if (!useful.length) return null;
  return <div className="event-list">{useful.map((event, index) => {
    if ((event.kind === "image" || event.kind === "file") && event.assetPointer) {
      if (event.assetPointer.startsWith("sediment://") && !upstreamConversationId) {
        return <span className="event-chip image" key={`${event.assetPointer}-${index}`}>▧ Image ready</span>;
      }
      return <AssetResult event={event} upstreamConversationId={upstreamConversationId} key={`${event.assetPointer}-${index}`} />;
    }
    return <span className={`event-chip ${event.kind}`} key={`${event.kind}-${index}`}>
      {event.kind === "citation" ? "▤" : "✦"} {event.title ?? event.name ?? event.kind}{event.status ? ` · ${event.status}` : ""}
    </span>;
  })}</div>;
}

function MessageBody({ message, upstreamConversationId }: { message: ChatMessage; upstreamConversationId?: string | null }) {
  return <>
    {message.role === "assistant" ? (
      message.content ? <Suspense fallback={<div className="plain-fallback">{message.content}</div>}><Markdown>{message.content}</Markdown></Suspense>
        : message.status === "streaming" ? <span className="thinking"><i /><i /><i /></span> : null
    ) : <div className="user-text">{message.content}</div>}
    {message.attachments?.length ? <div className="attachment-list">{message.attachments.map((file) => <span key={file.fileId}>📎 {file.fileName}</span>)}</div> : null}
    <EventChips events={message.events ?? []} upstreamConversationId={upstreamConversationId} />
  </>;
}

export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [models, setModels] = useState<ModelDescriptor[]>([]);
  const [gpts, setGpts] = useState<GizmoSummary[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("auto");
  const [gizmoId, setGizmoId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedGpt = useMemo(() => gpts.find((gpt) => gpt.id === gizmoId), [gpts, gizmoId]);
  const selectedModel = useMemo(() => models.find((item) => item.id === model), [models, model]);

  async function refreshProductData() {
    const [modelResult, gptResult, conversationResult] = await Promise.allSettled([getModels(), getGpts(), listConversations()]);
    if (modelResult.status === "fulfilled") setModels(modelResult.value);
    if (gptResult.status === "fulfilled") setGpts(gptResult.value);
    if (conversationResult.status === "fulfilled") setConversations(conversationResult.value);
  }

  useEffect(() => {
    getSessionStatus().then((status) => {
      setConfigured(status.configured);
      if (status.configured) void refreshProductData();
    }).catch((err) => { setConfigured(false); setError(String(err.message ?? err)); });
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  async function selectConversation(conversation: Conversation) {
    if (sending) return;
    const loaded = await loadConversation(conversation.id);
    setActive(loaded.conversation);
    setModel(loaded.conversation.model);
    setGizmoId(loaded.conversation.gizmoId ?? null);
    setMessages(loaded.messages.map((message) => ({ ...message, events: message.events ?? [] })));
    setSidebarOpen(window.innerWidth > 760);
  }

  function resetComposerConversation() {
    if (sending) return;
    setActive(null); setMessages([]); setInput(""); setAttachments([]); setError("");
  }


  async function chooseModel(nextModel: string) {
    setModel(nextModel);
    if (!active) return;
    try {
      const updated = await updateConversationModel(active.id, nextModel);
      setActive(updated);
      setConversations((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (err) { setError(String((err as Error).message ?? err)); }
  }

  function chooseGpt(nextGizmoId: string | null) {
    if (active) resetComposerConversation();
    setGizmoId(nextGizmoId);
  }

  async function sendPrompt(prompt: string, target = active, baseMessages = messages, files = attachments) {
    const clean = prompt.trim();
    if (!clean || sending) return;
    setInput(""); setAttachments([]); setSending(true); setError("");
    const user: ChatMessage = { id: uid(), role: "user", content: clean, status: "done", events: [], attachments: files };
    const assistantId = uid();
    const assistant: ChatMessage = { id: assistantId, role: "assistant", content: "", status: "streaming", events: [] };
    setMessages([...baseMessages, user, assistant]);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamChat({
        prompt: clean, model: target?.model ?? model, conversationId: target?.id ?? null,
        gizmoId: target?.gizmoId ?? gizmoId, attachments: files, signal: controller.signal,
        onDelta: (full) => setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: full } : item)),
        onEvent: (event) => setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, events: [...item.events, event] } : item)),
        onDone: (result) => {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, id: result.assistantMessageId, content: result.text, status: "done", upstreamNodeId: result.messageId } : item));
          setActive((current) => current?.id === result.conversationId ? { ...current, conversationId: result.upstreamConversationId, model: result.model } : current);
          void loadConversation(result.conversationId).then((loaded) => setActive(loaded.conversation));
          void listConversations().then(setConversations);
        },
        onError: (message) => {
          setMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: item.content || `⚠ ${message}`, status: "error" } : item));
          setError(message);
        },
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(String((err as Error).message ?? err));
    } finally {
      abortRef.current = null; setSending(false);
    }
  }

  async function handleStop() {
    abortRef.current?.abort();
    if (active) await stopConversation(active.id).catch(() => undefined);
    setSending(false);
    setMessages((current) => current.map((message) => message.status === "streaming" ? { ...message, status: "stopped" } : message));
  }

  async function handleFiles(files: FileList | File[]) {
    setUploading(true); setError("");
    try {
      const uploaded = await Promise.all(Array.from(files).map(uploadFile));
      setAttachments((current) => [...current, ...uploaded]);
    } catch (err) { setError(String((err as Error).message ?? err)); }
    finally { setUploading(false); }
  }

  async function makeBranch(message: ChatMessage): Promise<Conversation | null> {
    if (!active) return null;
    const branch = await branchConversation(active.id, message.id, `Branch · ${active.title}`);
    const loaded = await loadConversation(branch.id);
    setActive(loaded.conversation); setMessages(loaded.messages); setConversations(await listConversations());
    return loaded.conversation;
  }

  async function regenerate() {
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
    if (lastUserIndex < 0) return;
    const prompt = messages[lastUserIndex].content;
    const parent = messages.slice(0, lastUserIndex).findLast((message) => message.role === "assistant");
    if (parent && active) {
      const branch = await makeBranch(parent);
      if (branch) await sendPrompt(prompt, branch, messages.slice(0, lastUserIndex));
    } else {
      const fresh = await createConversation(model, gizmoId);
      setActive(fresh); setMessages([]); await sendPrompt(prompt, fresh, []);
    }
  }

  async function editMessage(index: number) {
    const edited = window.prompt("Edit your message", messages[index].content)?.trim();
    if (!edited || edited === messages[index].content) return;
    const parent = messages.slice(0, index).findLast((message) => message.role === "assistant");
    if (parent && active) {
      const branch = await makeBranch(parent);
      if (branch) await sendPrompt(edited, branch, messages.slice(0, index));
    } else {
      const fresh = await createConversation(model, gizmoId);
      setActive(fresh); setMessages([]); await sendPrompt(edited, fresh, []);
    }
  }

  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="sidebar-head"><div className="brand-mark">M</div><strong>Mirror</strong><button onClick={() => setSidebarOpen(false)} className="icon-button mobile-only">×</button></div>
      <button className="new-chat" onClick={resetComposerConversation}>＋ New chat</button>
      <div className="history-label">Recent</div>
      <nav className="history-list">{conversations.map((conversation) => <div className={`history-row ${active?.id === conversation.id ? "active" : ""}`} key={conversation.id}>
        <button onClick={() => void selectConversation(conversation)}><span>{conversation.title}</span><small>{conversation.gizmoId ? gpts.find((gpt) => gpt.id === conversation.gizmoId)?.name ?? "GPT" : conversation.model}</small></button>
        <button className="delete-chat" title="Delete" onClick={async () => { await deleteConversation(conversation.id); if (active?.id === conversation.id) resetComposerConversation(); setConversations(await listConversations()); }}>×</button>
      </div>)}</nav>
      <button className="account-button" onClick={() => setShowSettings(true)}><span className="avatar">●</span>{configured ? "Connected account" : "Connect account"}</button>
    </aside>
    {sidebarOpen && <button className="sidebar-scrim mobile-only" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

    <section className="main-panel">
      <header className="topbar">
        <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>☰</button>
        <div className="selectors">
          <Picker label="GPT" value={selectedGpt?.name ?? "ChatGPT"}>
            <button className={!gizmoId ? "selected" : ""} onClick={() => chooseGpt(null)}>ChatGPT</button>
            {gpts.map((gpt) => <button className={gpt.id === gizmoId ? "selected" : ""} onClick={() => chooseGpt(gpt.id)} key={gpt.id}>{gpt.iconUrl && <img src={gpt.iconUrl} alt="" />}<span>{gpt.name}</span></button>)}
          </Picker>
          <Picker label="Model" value={selectedModel?.title ?? (model === "auto" ? "Auto" : model)}>
            <button className={model === "auto" ? "selected" : ""} onClick={() => void chooseModel("auto")}>Auto</button>
            {models.map((item) => <button className={item.id === model ? "selected" : ""} onClick={() => void chooseModel(item.id)} key={item.id}><span>{item.title}</span><small>{item.id}{item.id.endsWith("-wm") ? " · interactive fallback" : ""}</small></button>)}
          </Picker>
        </div>
        <div className="topbar-title">{active?.title ?? selectedGpt?.description ?? ""}</div>
      </header>

      <main className="chat" ref={scrollRef} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void handleFiles(event.dataTransfer.files); }}>
        {messages.length === 0 ? <div className="empty-state">
          <div className="empty-logo">{selectedGpt?.iconUrl ? <img src={selectedGpt.iconUrl} alt="" /> : "M"}</div>
          <h1>{selectedGpt?.name ?? "How can I help?"}</h1>
          <p>{configured === false ? "Connect your ChatGPT account to begin." : selectedGpt?.description ?? "A fast, private interface to your ChatGPT account."}</p>
          {configured === false && <button className="primary" onClick={() => setShowSettings(true)}>Connect account</button>}
        </div> : <div className="message-column">{messages.map((message, index) => <article className={`message ${message.role}`} key={message.id}>
          <div className="message-avatar">{message.role === "user" ? "You" : selectedGpt?.name?.slice(0, 1) ?? "M"}</div>
          <div className="message-main"><div className="message-body"><MessageBody message={message} upstreamConversationId={active?.conversationId} /></div>
            {message.status !== "streaming" && <div className="message-actions">
              <button onClick={() => navigator.clipboard.writeText(message.content)}>Copy</button>
              {message.role === "user" && <button onClick={() => void editMessage(index)}>Edit</button>}
              {message.role === "assistant" && message.upstreamNodeId && <button onClick={() => void makeBranch(message)}>Branch</button>}
              {message.role === "assistant" && index === messages.length - 1 && <button onClick={() => void regenerate()}>Regenerate</button>}
            </div>}
          </div>
        </article>)}</div>}
      </main>

      <footer className="composer-wrap">
        {error && <div className="error-banner">{error}<button onClick={() => setError("")}>×</button></div>}
        {attachments.length > 0 && <div className="pending-files">{attachments.map((file) => <span key={file.fileId}>📎 {file.fileName}<button onClick={() => setAttachments((current) => current.filter((item) => item.fileId !== file.fileId))}>×</button></span>)}</div>}
        <div className="composer-box">
          <button className="attach-button" title="Attach files" onClick={() => fileRef.current?.click()} disabled={!configured || sending || uploading}>＋</button>
          <input ref={fileRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) void handleFiles(event.target.files); event.target.value = ""; }} />
          <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendPrompt(input); }
          }} placeholder={configured ? uploading ? "Uploading…" : `Message ${selectedGpt?.name ?? "ChatGPT"}` : "Connect your account first"} disabled={!configured || sending} rows={1} />
          {sending ? <button className="send-button stop" onClick={() => void handleStop()} title="Stop">■</button>
            : <button className="send-button" onClick={() => void sendPrompt(input)} disabled={!configured || !input.trim() || uploading} title="Send">↑</button>}
        </div>
        <small>Mirror uses ChatGPT Web through your own account. Outputs can be inaccurate.</small>
      </footer>
    </section>

    {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onSaved={() => { setShowSettings(false); setConfigured(true); void refreshProductData(); }} />}
  </div>;
}
