import { Agent, setGlobalDispatcher } from "undici";

const CLOUDFLARE_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";

export interface EgressStatus {
  mode: "direct" | "warp";
  required: boolean;
  verified: boolean;
  checkedAt: string | null;
  error: string | null;
}

let status: EgressStatus = {
  mode: "direct",
  required: true,
  verified: false,
  checkedAt: null,
  error: null,
};

// Use one connection pool for every server-side fetch. In the Compose setup the
// server shares the WARP container's network namespace, so this dispatcher and
// all protocol-package fetches use the same tunnel without application-level
// proxy exceptions or a short-lived local-proxy connection.
setGlobalDispatcher(new Agent({
  connect: { ALPNProtocols: ["http/1.1"] },
  keepAliveTimeout: 30_000,
}));

export function parseCloudflareTrace(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return fields;
}

export function getEgressStatus(): EgressStatus {
  return { ...status };
}

/**
 * Verify WARP using Cloudflare's own documented trace endpoint. The trace body
 * also contains an IP and location; neither is retained or logged.
 */
export async function verifyRequiredEgress(): Promise<EgressStatus> {
  try {
    const response = await fetch(CLOUDFLARE_TRACE_URL, {
      headers: { accept: "text/plain" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cloudflare trace returned HTTP ${response.status}`);
    const trace = parseCloudflareTrace(await response.text());
    if (trace.warp !== "on") throw new Error("Cloudflare trace did not report warp=on");
    status = {
      mode: "warp",
      required: true,
      verified: true,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (error) {
    status = {
      mode: "direct",
      required: true,
      verified: false,
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "WARP verification failed",
    };
    throw new Error(`Mirror requires WARP, but WARP egress could not be verified: ${status.error}`);
  }
  return getEgressStatus();
}

export function monitorRequiredEgress(onFailure: (error: Error) => void, intervalMs = 30_000): () => void {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void verifyRequiredEgress()
      .catch((error: Error) => onFailure(error))
      .finally(() => { checking = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
