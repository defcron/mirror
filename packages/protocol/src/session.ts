/**
 * Turns a long-lived NextAuth session token into short-lived backend-api
 * accessTokens, minting fresh ones on demand.
 *
 * Background (see project docs / README): chatgpt.com's `accessToken` (the
 * JWT used as `Authorization: Bearer` against backend-api) is short-lived —
 * documented around ~2 weeks. The `__Secure-next-auth.session-token` cookie
 * that mints it is longer-lived — documented around ~1 month — and calling
 * `GET https://chatgpt.com/api/auth/session` with that cookie returns a fresh
 * accessToken. Critically, NextAuth ROTATES the session token on each such
 * call: the response's `Set-Cookie` can carry a new session-token value that
 * must be persisted, or the next mint attempt will use a stale, invalid one.
 */

const SESSION_URL = "https://chatgpt.com/api/auth/session";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const SESSION_COOKIE_NAME = "__Secure-next-auth.session-token";

export interface MintedAccessToken {
  accessToken: string;
  /** Epoch ms when this accessToken should be treated as expired and re-minted. */
  expiresAt: number;
  /**
   * If the server rotated the session token on this call, its new value —
   * callers MUST persist this and use it for the next mint, or subsequent
   * mints will fail once the old value stops being honored.
   */
  rotatedSessionToken: string | null;
}

/** Decode a JWT's `exp` claim (seconds since epoch) without verifying the signature — we don't hold the key, and we trust the origin because we're the ones who just fetched it over TLS from chatgpt.com. */
function decodeJwtExpSeconds(jwt: string): number | null {
  try {
    const payloadB64Url = jwt.split(".")[1];
    if (!payloadB64Url) return null;
    const b64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const claims = JSON.parse(json);
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

function extractRotatedSessionToken(res: Response): string | null {
  // Node's fetch (undici) exposes multiple Set-Cookie values via getSetCookie(); fall back to a
  // single combined header on runtimes that don't support it.
  const raw: string[] =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie()
      : [res.headers.get("set-cookie") ?? ""].filter(Boolean);

  for (const cookieStr of raw) {
    const match = cookieStr.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

export class SessionTokenInvalidError extends Error {
  constructor(message = "Session token was rejected or has no accessToken in the response — it's likely expired.") {
    super(message);
    this.name = "SessionTokenInvalidError";
  }
}

/** Exchange a session token for a fresh accessToken. Throws SessionTokenInvalidError if the session token itself is no good. */
export async function mintAccessToken(sessionToken: string): Promise<MintedAccessToken> {
  const res = await fetch(SESSION_URL, {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new SessionTokenInvalidError(`GET /api/auth/session returned ${res.status}`);
  }

  const json: any = await res.json().catch(() => null);
  if (!json || typeof json.accessToken !== "string" || json.accessToken.length === 0) {
    throw new SessionTokenInvalidError();
  }

  const expSeconds = decodeJwtExpSeconds(json.accessToken);
  const expiresAt = expSeconds ? expSeconds * 1000 : Date.now() + 10 * 60 * 1000; // fallback: 10 min if unparseable

  return {
    accessToken: json.accessToken,
    expiresAt,
    rotatedSessionToken: extractRotatedSessionToken(res),
  };
}
