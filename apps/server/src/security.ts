import { timingSafeEqual } from "node:crypto";
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
    if (requestHostname && originUrl.hostname.toLowerCase() === requestHostname)
      return true;
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
