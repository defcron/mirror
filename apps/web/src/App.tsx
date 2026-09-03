import { useEffect, useMemo, useRef, useState } from "react";

interface ApiModel { id: string; owned_by?: string; name?: string }
interface TestMessage { role: "system" | "user" | "assistant"; content: string }

const DEFAULT_MESSAGES: TestMessage[] = [
  { role: "system", content: "You are a helpful assistant." },
  { role: "user", content: "Say hello in one short sentence." },
];
const STORAGE_KEY_CONVERSATION_ID = "mirror-playground-conversation-id";
const STORAGE_KEY_MESSAGES = "mirror-playground-messages";

function loadStoredConversationId(): string {
  try { return localStorage.getItem(STORAGE_KEY_CONVERSATION_ID) ?? ""; } catch { return ""; }
}
function loadStoredMessages(): TestMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MESSAGES);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* fall through to defaults */ }
  return DEFAULT_MESSAGES;
}

function Header() {
  return <header className="platform-header"><a className="platform-brand" href="/"><span className="openai-mark">◎</span><b>Mirror API</b></a><nav><a href="/">ChatGPT</a><a className="active" href="/mirror/playground">Playground</a><a href="/v1/models" target="_blank" rel="noreferrer">Models</a></nav><div className="environment">Local server</div></header>;
}

export default function App() {
  const [domain, setDomain] = useState(() => location.origin);
  const [path, setPath] = useState("/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ApiModel[]>([]);
  const [model, setModel] = useState("auto");
  const [modelFreeform, setModelFreeform] = useState(false);
  const [pickedModel, setPickedModel] = useState("");
  const [privateChat, setPrivateChat] = useState(false);
  const [oneShot, setOneShot] = useState(false);
  // Persisted to localStorage (see effects below) so a page refresh doesn't
  // strand you: the conversation id is exactly what lets you resume an
  // existing upstream conversation, so losing it on refresh defeated the
  // point - every "continue an existing conversation" attempt after a
  // reload silently started a brand-new one instead.
  const [conversationId, setConversationId] = useState<string>(loadStoredConversationId);
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState(1);
  const [messages, setMessages] = useState<TestMessage[]>(loadStoredMessages);
  const [output, setOutput] = useState("");
  const [raw, setRaw] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [controller, setController] = useState<AbortController | null>(null);
  const endpoint = useMemo(() => `${domain.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`, [domain, path]);
  useEffect(() => {
    try {
      if (conversationId) localStorage.setItem(STORAGE_KEY_CONVERSATION_ID, conversationId);
      else localStorage.removeItem(STORAGE_KEY_CONVERSATION_ID);
    } catch { /* best-effort */ }
  }, [conversationId]);
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY_MESSAGES, JSON.stringify(messages)); } catch { /* best-effort */ }
  }, [messages]);
  const isGizmoModel = /^g-/.test(model);
  const lastMessage = messages.at(-1);
  // Not used to disable the Run button (that turned out to trap people who
  // typed into the freshly-appended row and still saw it stay disabled) -
  // only to show *why* a click was a no-op, via runBlockedReason below.
  const canRun = Boolean(lastMessage && lastMessage.role === "user" && lastMessage.content.trim());
  const runBlockedReason = !lastMessage || lastMessage.role !== "user"
    ? "The last message must be from the user."
    : !lastMessage.content.trim()
      ? "Type a message in the last (user) row before running."
      : null;

  useEffect(() => { fetch(`${location.origin}/v1/models`).then((res) => res.json()).then((body) => { if (Array.isArray(body.data)) setModels(body.data); }).catch(() => undefined); }, []);
  function updateMessage(index: number, key: keyof TestMessage, value: string) { setMessages((current) => current.map((message, i) => i === index ? { ...message, [key]: value } : message)); }

  const runningRef = useRef(false);
  async function run() {
    // Belt-and-suspenders against a double-fire (rapid double-click, a stray
    // repeated key event, etc) beating React's state-driven button swap:
    // that used to race two overlapping requests for the same conversation
    // and could leave a sibling reply logged upstream with no user message
    // of its own attached to it.
    if (runningRef.current) return;
    if (!canRun) { setStatus("Blocked"); setRaw(runBlockedReason ?? "Cannot run."); setShowRaw(true); return; }
    runningRef.current = true;
    const abort = new AbortController();
    setController(abort); setRunning(true); setOutput(""); setRaw(""); setStatus("Running…");
    try {
      const metadata: Record<string, string> = {};
      if (privateChat) metadata.private = "true";
      if (isGizmoModel && pickedModel.trim()) metadata.mirror_model = pickedModel.trim();
      if (conversationId.trim()) metadata.conversation_id = conversationId.trim();
      const response = await fetch(endpoint, { method: "POST", signal: abort.signal, headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model, messages, stream, temperature, store: !oneShot, ...(Object.keys(metadata).length ? { metadata } : {}) }) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const returnedConversationId = response.headers.get("x-mirror-conversation-id");
      if (returnedConversationId) setConversationId(returnedConversationId);
      let finalText = "";
      if (!stream) {
        const body = await response.json(); setRaw(JSON.stringify(body, null, 2));
        finalText = body.choices?.[0]?.message?.content ?? ""; setOutput(finalText);
      } else if (response.body) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let complete = ""; let transcript = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? "";
          for (const frame of frames) {
            // Comment lines (": mirror-conversation-id <id>") carry the
            // conversation id out-of-band since it may not be known until
            // after the first chunk has already been written to the client.
            const commentId = frame.split(/\r?\n/).find((line) => line.startsWith(": mirror-conversation-id "))?.slice(25).trim();
            if (commentId) setConversationId(commentId);
            const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim(); if (!data || data === "[DONE]") continue;
            transcript += `${data}\n`; const chunk = JSON.parse(data); complete += chunk.choices?.[0]?.delta?.content ?? ""; setOutput(complete); setRaw(transcript);
          }
        }
        finalText = complete;
      }
      // The server threads continuations by matching the exact prior message
      // array (including the assistant's own reply) against a saved
      // fingerprint. Append the reply here so the next Run's request body
      // reproduces that exact prefix and lands on the same conversationId
      // instead of silently starting a new thread each time.
      if (finalText && !oneShot) {
        setMessages((current) => [...current, { role: "assistant", content: finalText }, { role: "user", content: "" }]);
      }
      setStatus("Completed");
    } catch (error) {
      if ((error as Error).name === "AbortError") setStatus("Stopped"); else { setStatus("Error"); setRaw(String((error as Error).message ?? error)); setShowRaw(true); }
    } finally { runningRef.current = false; setRunning(false); setController(null); }
  }

  return <div className="playground-app"><Header />
    <aside className="playground-sidebar"><div className="side-title">Playground</div><button className="side-item active"><span>☷</span> Chat</button><button className="side-item" disabled><span>◇</span> Responses</button><div className="side-section">Mirror</div><a className="side-item" href="/"><span>↗</span> Open ChatGPT</a><a className="side-item" href="/api/health" target="_blank" rel="noreferrer"><span>♥</span> Server health</a><div className="server-card"><b>Compatible endpoint</b><p>Test Mirror or any OpenAI-compatible server directly from your browser.</p></div></aside>
    <main className="workbench"><div className="workbench-head"><div><h1>Chat</h1><p>Test an OpenAI-compatible Chat Completions endpoint.</p></div><div className="run-actions"><span className={`run-status ${status.toLowerCase()}`}>{status}</span>{running ? <button className="stop-button" onClick={() => controller?.abort()}>Stop</button> : <button className="run-button" title={canRun ? undefined : runBlockedReason ?? undefined} onClick={() => void run()}>Run <span>⌘ ↵</span></button>}</div></div>
      <div className="connection-bar"><label><span>Server domain</span><input value={domain} onChange={(event) => setDomain(event.target.value)} /></label><label><span>Path</span><input value={path} onChange={(event) => setPath(event.target.value)} /></label><label><span>Bearer credential</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Optional for this server" /></label></div>
      <div className="columns"><section className="prompt-panel"><div className="panel-title"><b>Messages</b><button onClick={() => setMessages((current) => [...current, { role: "user", content: "" }])}>＋ Add message</button></div><div className="messages-editor">{messages.map((message, index) => <div className="message-editor" key={index}><div className="message-toolbar"><select value={message.role} onChange={(event) => updateMessage(index, "role", event.target.value)}><option>system</option><option>user</option><option>assistant</option></select><button aria-label="Remove message" onClick={() => setMessages((current) => current.filter((_, i) => i !== index))}>×</button></div><textarea value={message.content} onChange={(event) => updateMessage(index, "content", event.target.value)} /></div>)}</div></section>
        <section className="response-panel"><div className="response-tabs"><button className={!showRaw ? "active" : ""} onClick={() => setShowRaw(false)}>Output</button><button className={showRaw ? "active" : ""} onClick={() => setShowRaw(true)}>Raw response</button></div><div className={`output ${(showRaw ? raw : output) ? "" : "empty"}`}>{(showRaw ? raw : output) || "Run the request to see the model response."}</div></section>
        <aside className="settings-panel"><h2>Configuration</h2><label><span>Model</span><div className="model-picker-row">{modelFreeform ? <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="official model, g-… gizmo id, or g-p-… project id" /> : <select value={model} onChange={(event) => setModel(event.target.value)}><option value="auto">auto</option>{models.map((item) => <option value={item.id} key={item.id}>{item.owned_by === "chatgpt-gizmo" ? `GPT: ${item.name ?? item.id}` : item.owned_by === "chatgpt-project" ? `Project: ${item.name ?? item.id}` : item.id}</option>)}</select>}<button type="button" className="model-mode-toggle" onClick={() => setModelFreeform((current) => !current)}>{modelFreeform ? "Use list" : "Type manually"}</button></div></label>{isGizmoModel && <label><span>Picked model for this GPT/Project</span><input value={pickedModel} onChange={(event) => setPickedModel(event.target.value)} placeholder="e.g. gpt-5-6, or another g-… / g-p-… id (experimental)" /></label>}<label><span>Temperature</span><div className="range-line"><input type="range" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /><output>{temperature.toFixed(1)}</output></div></label><label className="switch-line"><span>Stream response</span><input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} /></label><label className="switch-line"><span>Private chat</span><input type="checkbox" checked={privateChat} onChange={(event) => setPrivateChat(event.target.checked)} /></label><label className="switch-line"><span>One-shot (don't save thread)</span><input type="checkbox" checked={oneShot} onChange={(event) => setOneShot(event.target.checked)} /></label><label><span>Conversation ID</span><div className="model-picker-row"><input value={conversationId} onChange={(event) => setConversationId(event.target.value)} placeholder="auto (filled in after the first response)" /><button type="button" className="model-mode-toggle" onClick={() => { setConversationId(""); setMessages([{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "" }]); }}>New</button></div></label><div className="request-preview"><span>Request URL</span><code>{endpoint}</code></div></aside></div>
    </main></div>;
}
