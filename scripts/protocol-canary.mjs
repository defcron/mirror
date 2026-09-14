// Opt-in live protocol canary (MIR-32, NEXT-STEPS.md section 3).
//
// Read-only by default: checks that a running Mirror instance can actually
// reach chatgpt.com/backend-api right now (WARP egress, a healthy saved
// session, live model discovery) and prints a sanitized report suitable for
// attaching to an issue when something about the private protocol has
// drifted. Never touches the database directly and never prints a session
// token, access token, cookie, or any upstream response body - only the
// already-sanitized fields Mirror's own /api/diagnostics and /api/models
// routes return.
//
// A real generation (--generate) is opt-in and explicit, since it consumes a
// disposable turn against your actual ChatGPT usage: it POSTs a trivial,
// throwaway prompt to /v1/chat/completions and reports only success/failure
// and timing, never the prompt or the reply text.
//
// Usage:
//   node scripts/protocol-canary.mjs [--base-url=http://127.0.0.1:8799] [--generate]
//   MIRROR_API_KEY must be set (or passed via --api-key=...) for the
//   /v1/* generation check; the read-only checks use Mirror's own
//   same-origin-exempt /api/* routes and work without a key when run
//   against a loopback instance the way this script does.

const args = process.argv.slice(2);
function flag(name, fallback) {
  const prefix = `--${name}=`;
  const found = args.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
const generate = args.includes("--generate");
const baseUrl = (flag("base-url", process.env.MIRROR_BASE_URL ?? "http://127.0.0.1:8799")).replace(/\/$/, "");
const apiKey = flag("api-key", process.env.MIRROR_API_KEY ?? process.env.OPENAI_API_KEY);

const report = { checkedAt: new Date().toISOString(), baseUrl, checks: [] };

async function check(name, fn) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    report.checks.push({ name, ok: true, ms: Date.now() - startedAt, detail });
  } catch (error) {
    report.checks.push({
      name,
      ok: false,
      ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await check("health", async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  if (!res.ok) throw new Error(`GET /api/health -> HTTP ${res.status}`);
  const body = await res.json();
  if (!body.ok) throw new Error(`Mirror reports unhealthy: ${JSON.stringify(body)}`);
  return { egress: body.egress?.mode, configured: body.configured };
});

await check("diagnostics", async () => {
  const res = await fetch(`${baseUrl}/api/diagnostics`);
  if (!res.ok) throw new Error(`GET /api/diagnostics -> HTTP ${res.status}`);
  const body = await res.json();
  return { schemaVersion: body.storage?.schemaVersion, warp: body.warp?.mode, session: body.session?.state };
});

await check("model-discovery", async () => {
  const res = await fetch(`${baseUrl}/api/models`);
  if (!res.ok) throw new Error(`GET /api/models -> HTTP ${res.status}`);
  const models = await res.json();
  if (!Array.isArray(models) || models.length === 0) throw new Error("no models returned");
  return { modelCount: models.length };
});

if (generate) {
  if (!apiKey) {
    report.checks.push({
      name: "disposable-generation",
      ok: false,
      error: "--generate requires MIRROR_API_KEY (or OPENAI_API_KEY) in the environment, or --api-key=...",
    });
  } else {
    await check("disposable-generation", async () => {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "canary: reply with the single word ok" }],
          store: false,
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`POST /v1/chat/completions -> HTTP ${res.status}`);
      const body = await res.json();
      // Never record the actual reply text - only that one was produced.
      return { hasReply: Boolean(body.choices?.[0]?.message?.content), finishReason: body.choices?.[0]?.finish_reason };
    });
  }
} else {
  report.checks.push({
    name: "disposable-generation",
    ok: null,
    skipped: "pass --generate to run one real, disposable turn (consumes real ChatGPT usage)",
  });
}

report.ok = report.checks.every((c) => c.ok !== false);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
