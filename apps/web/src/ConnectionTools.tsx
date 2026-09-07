import { useState } from "react";

export function ConnectionTools({ domain, apiKey, generationSucceeded }: { domain: string; apiKey: string; generationSucceeded: boolean }) {
  const [diagnostics, setDiagnostics] = useState<unknown>(null);
  const [status, setStatus] = useState("Not tested");
  const [busy, setBusy] = useState(false);
  async function testConnection() {
    setBusy(true);
    setStatus("Checking API and local diagnostics…");
    try {
      const health = await fetch("/api/diagnostics");
      if (!health.ok) throw new Error(`Diagnostics returned HTTP ${health.status}`);
      setDiagnostics(await health.json());
      const models = await fetch(`${domain.replace(/\/$/, "")}/v1/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
      if (!models.ok) throw new Error(`Model discovery returned HTTP ${models.status}. Check the key, WARP, and saved session.`);
      const body = await models.json();
      if (!Array.isArray(body.data)) throw new Error("Model discovery returned an unsupported response.");
      setStatus(`Model discovery passed (${body.data.length} models). ${apiKey ? "Bearer credential supplied." : "Browser authentication used; a client key has not been tested."}`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Connection test failed"); }
    finally { setBusy(false); }
  }
  const snippet = 'from openai import OpenAI\nclient = OpenAI(base_url="http://127.0.0.1:8799/v1", api_key="YOUR_MIRROR_KEY")';
  return <details className="utility-panel">
    <summary>Connection diagnostics and client setup</summary>
    <button disabled={busy} onClick={() => void testConnection()}>Test connection</button>
    <p role="status">{status}</p>
    <p>Generation: {generationSucceeded ? "completed in this Playground session" : "not verified; use Run to send a test message"}.</p>
    {diagnostics !== null && <><pre>{JSON.stringify(diagnostics, null, 2)}</pre><a href="/api/diagnostics" download="mirror-diagnostics.json">Export local diagnostics</a></>}
    <p>Diagnostics describe this local Mirror. Model discovery tests the selected server domain.</p>
    <pre tabIndex={0}>{snippet}</pre>
    <button onClick={() => void navigator.clipboard.writeText(snippet).then(() => setStatus("Setup snippet copied"), () => setStatus("Select and copy the setup snippet above"))}>Copy setup snippet</button>
    <p>cm uses the server root: <code>CM_BASE_URL=http://127.0.0.1:8799</code>. ChatGPTBox uses the OpenAI-compatible provider, a Mirror model ID, and the completion URL ending in <code>/v1/chat/completions</code> when a full endpoint is requested.</p>
  </details>;
}
