/**
 * Rewrites absolute ChatGPT origins embedded in upstream textual assets so
 * browser code served by Mirror talks back to Mirror instead of bypassing it.
 *
 * This is deliberately done server-side: window-level monkey patches do not
 * affect DedicatedWorker/SharedWorker/ServiceWorker globals, and modern ChatGPT
 * moves a substantial amount of transport code into workers.
 */

const CHATGPT_WEB_HOSTS = String.raw`(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com`;

export function isRewritableContentType(contentType: string): boolean {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    type.startsWith("text/") ||
    type === "application/javascript" ||
    type === "application/x-javascript" ||
    type === "application/ecmascript" ||
    type === "application/json" ||
    type === "application/manifest+json"
  );
}

export function requestOrigin(protocol: string, host: string | undefined): string | null {
  if (!host) return null;
  const scheme = protocol === "https" ? "https" : "http";
  return `${scheme}://${host}`;
}

/**
 * Rewrite both normal and JSON-escaped absolute URLs. We intentionally only
 * touch the ChatGPT web origin; signed blob/CDN URLs and unrelated external
 * services must remain untouched.
 */
export function rewriteChatGptUrls(input: string, proxyOrigin: string): string {
  const proxyWebSocketOrigin = proxyOrigin.replace(/^http/, "ws");
  const escapedProxy = proxyOrigin.replaceAll("/", "\\/");
  const escapedWebSocketProxy = proxyWebSocketOrigin.replaceAll("/", "\\/");

  return input
    .replace(new RegExp(`https://${CHATGPT_WEB_HOSTS}`, "gi"), proxyOrigin)
    .replace(new RegExp(`wss://${CHATGPT_WEB_HOSTS}`, "gi"), proxyWebSocketOrigin)
    .replace(
      /https:(?:\\\/){2}(?:(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com)/gi,
      escapedProxy,
    )
    .replace(
      /wss:(?:\\\/){2}(?:(?:[a-z0-9-]+\.)*chatgpt\.com|chat\.openai\.com)/gi,
      escapedWebSocketProxy,
    );
}
