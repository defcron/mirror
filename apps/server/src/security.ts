import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

function hostnameFromHost(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname
      .replace(/^\[|\]$/g, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

export function configuredApiKeys(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [env.MIRROR_API_KEY, ...(env.MIRROR_API_KEYS ?? "").split(",")]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

export function isAllowedRequestHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = hostnameFromHost(host);
  if (!hostname) return false;
  return isLoopbackHostname(hostname);
}

export function isAllowedOrigin(
  origin: string | undefined,
  requestHost: string | undefined,
): boolean {
  if (!origin) return true; // Non-browser clients do not normally send Origin.
  try {
    const originUrl = new URL(origin);
    const requestHostname = requestHost ? hostnameFromHost(requestHost) : null;
    if (requestHostname && originUrl.origin === new URL(`http://${requestHost}`).origin) return true;
    const developmentOrigin =
      process.env.MIRROR_WEB_ORIGIN ?? "http://localhost:5173";
    return originUrl.origin === new URL(developmentOrigin).origin;
  } catch {
    return false;
  }
}

export function tokenMatches(candidate: string, accepted: string[]): boolean {
  const candidateBytes = Buffer.from(candidate);
  return accepted.some((token) => {
    const tokenBytes = Buffer.from(token);
    return (
      tokenBytes.length === candidateBytes.length &&
      timingSafeEqual(tokenBytes, candidateBytes)
    );
  });
}

export function bearerToken(authorization: string | undefined): string {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
}

const controlSecret = randomBytes(32).toString("base64url");
export function controlCookie(): string { return `mirror_control=${controlSecret}; Path=/; HttpOnly; SameSite=Strict`; }
export function authorizedLocalRequest(headers: { authorization?: string; cookie?: string }): boolean {
  if (tokenMatches(bearerToken(headers.authorization), configuredApiKeys())) return true;
  const cookie = headers.cookie?.split(";").map(x => x.trim()).find(x => x.startsWith("mirror_control="))?.slice(15) ?? "";
  return tokenMatches(cookie, [controlSecret]);
}
export function mayBootstrapBrowser(method: string, url: string, headers: Record<string, unknown>): boolean {
  return method === "GET" && (url === "/" || url === "/mirror/playground") &&
    String(headers.accept ?? "").includes("text/html") && headers["sec-fetch-site"] !== "cross-site";
}
