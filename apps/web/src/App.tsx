import { useEffect, useMemo, useState } from "react";

interface ApiModel { id: string }
interface TestMessage { role: "system" | "user" | "assistant"; content: string }

function Header() {
  return <header className="platform-header"><a className="platform-brand" href="/"><span className="openai-mark">◎</span><b>Mirror API</b></a><nav><a href="/">ChatGPT</a><a className="active" href="/mirror/playground">Playground</a><a href="/v1/models" target="_blank" rel="noreferrer">Models</a></nav><div className="environment">Local server</div></header>;
}

export default function App() {
  const [domain, setDomain] = useState(() => location.origin);
  const [path, setPath] = useState("/v1/chat/completions");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ApiModel[]>([]);
  const [model, setModel] = useState("auto");
  const [stream, setStream] = useState(true);
  const [temperature, setTemperature] = useState(1);
  const [messages, setMessages] = useState<TestMessage[]>([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Say hello in one short sentence." },
  ]);
  const [output, setOutput] = useState("");
  const [raw, setRaw] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [controller, setController] = useState<AbortController | null>(null);
  const endpoint = useMemo(() => `${domain.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`, [domain, path]);

  useEffect(() => { fetch(`${location.origin}/v1/models`).then((res) => res.json()).then((body) => { if (Array.isArray(body.data)) setModels(body.data); }).catch(() => undefined); }, []);
  function updateMessage(index: number, key: keyof TestMessage, value: string) { setMessages((current) => current.map((message, i) => i === index ? { ...message, [key]: value } : message)); }

  async function run() {
    const abort = new AbortController();
    setController(abort); setRunning(true); setOutput(""); setRaw(""); setStatus("Running…");
    try {
      const response = await fetch(endpoint, { method: "POST", signal: abort.signal, headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify({ model, messages, stream, temperature }) });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      if (!stream) {
        const body = await response.json(); setRaw(JSON.stringify(body, null, 2)); setOutput(body.choices?.[0]?.message?.content ?? "");
      } else if (response.body) {
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; let complete = ""; let transcript = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).find((line) => line.startsWith("data:"))?.slice(5).trim(); if (!data || data === "[DONE]") continue;
            transcript += `${data}\n`; const chunk = JSON.parse(data); complete += chunk.choices?.[0]?.delta?.content ?? ""; setOutput(complete); setRaw(transcript);
          }
        }
      }
      setStatus("Completed");
    } catch (error) {
      if ((error as Error).name === "AbortError") setStatus("Stopped"); else { setStatus("Error"); setRaw(String((error as Error).message ?? error)); setShowRaw(true); }
    } finally { setRunning(false); setController(null); }
  }

  return <div className="playground-app"><Header />
    <aside className="playground-sidebar"><div className="side-title">Playground</div><button className="side-item active"><span>☷</span> Chat</button><button className="side-item" disabled><span>◇</span> Responses</button><div className="side-section">Mirror</div><a className="side-item" href="/"><span>↗</span> Open ChatGPT</a><a className="side-item" href="/api/health" target="_blank" rel="noreferrer"><span>♥</span> Server health</a><div className="server-card"><b>Compatible endpoint</b><p>Test Mirror or any OpenAI-compatible server directly from your browser.</p></div></aside>
    <main className="workbench"><div className="workbench-head"><div><h1>Chat</h1><p>Test an OpenAI-compatible Chat Completions endpoint.</p></div><div className="run-actions"><span className={`run-status ${status.toLowerCase()}`}>{status}</span>{running ? <button className="stop-button" onClick={() => controller?.abort()}>Stop</button> : <button className="run-button" onClick={() => void run()}>Run <span>⌘ ↵</span></button>}</div></div>
      <div className="connection-bar"><label><span>Server domain</span><input value={domain} onChange={(event) => setDomain(event.target.value)} /></label><label><span>Path</span><input value={path} onChange={(event) => setPath(event.target.value)} /></label><label><span>Bearer credential</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Optional for this server" /></label></div>
      <div className="columns"><section className="prompt-panel"><div className="panel-title"><b>Messages</b><button onClick={() => setMessages((current) => [...current, { role: "user", content: "" }])}>＋ Add message</button></div><div className="messages-editor">{messages.map((message, index) => <div className="message-editor" key={index}><div className="message-toolbar"><select value={message.role} onChange={(event) => updateMessage(index, "role", event.target.value)}><option>system</option><option>user</option><option>assistant</option></select><button aria-label="Remove message" onClick={() => setMessages((current) => current.filter((_, i) => i !== index))}>×</button></div><textarea value={message.content} onChange={(event) => updateMessage(index, "content", event.target.value)} /></div>)}</div></section>
        <section className="response-panel"><div className="response-tabs"><button className={!showRaw ? "active" : ""} onClick={() => setShowRaw(false)}>Output</button><button className={showRaw ? "active" : ""} onClick={() => setShowRaw(true)}>Raw response</button></div><div className={`output ${(showRaw ? raw : output) ? "" : "empty"}`}>{(showRaw ? raw : output) || "Run the request to see the model response."}</div></section>
        <aside className="settings-panel"><h2>Configuration</h2><label><span>Model</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="auto">auto</option>{models.map((item) => <option value={item.id} key={item.id}>{item.id}</option>)}</select></label><label><span>Temperature</span><div className="range-line"><input type="range" min="0" max="2" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /><output>{temperature.toFixed(1)}</output></div></label><label className="switch-line"><span>Stream response</span><input type="checkbox" checked={stream} onChange={(event) => setStream(event.target.checked)} /></label><div className="request-preview"><span>Request URL</span><code>{endpoint}</code></div></aside></div>
    </main></div>;
}
