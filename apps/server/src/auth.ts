import {
  mintAccessToken,
  SessionTokenInvalidError,
  type SessionCredentials,
} from "@mirror/protocol";
import { getSession, updateMintedToken, getSessionRevision, assertSessionRevision } from "./store.js";
import { randomUUID } from "node:crypto";

const REFRESH_BUFFER_MS = 60_000; // re-mint a bit before actual expiry, not right at the edge
let refreshRevision = -1;
let refreshInFlight: Promise<SessionCredentials> | null = null;

/**
 * Returns valid backend-api credentials, minting a fresh accessToken from the
 * stored session token if we don't have a cached one or it's about to expire.
 * Persists both the new accessToken and any rotated session token.
 */
export async function getValidCredentials(): Promise<SessionCredentials> {
  const session = getSession();
  if (!session) {
    const err = new Error("No session configured. POST /api/session first.");
    (err as any).statusCode = 401;
    throw err;
  }

  const needsMint =
    !session.cachedAccessToken ||
    !session.cachedAccessTokenExpiresAt ||
    session.cachedAccessTokenExpiresAt - Date.now() < REFRESH_BUFFER_MS;

  if (!needsMint) {
    return {
      accessToken: session.cachedAccessToken!,
      deviceId: session.deviceId,
      sessionToken: session.sessionToken,
    };
  }

  if (refreshRevision !== getSessionRevision()) refreshInFlight = null;
  if (!refreshInFlight) {
    refreshRevision = getSessionRevision();
    const startedRevision = refreshRevision;
    refreshInFlight = (async () => {
      try {
        // No await precedes this operation, so the validated session snapshot
        // is still current. The revision check below guards the asynchronous mint.
        const current = session;
        const revision = getSessionRevision();
        const minted = await mintAccessToken(current.sessionToken);
        assertSessionRevision(revision);
        updateMintedToken(
          minted.accessToken,
          minted.expiresAt,
          minted.rotatedSessionToken,
        );
        return {
          accessToken: minted.accessToken,
          deviceId: current.deviceId,
          sessionToken: minted.rotatedSessionToken ?? current.sessionToken,
        };
      } catch (err) {
        if (err instanceof SessionTokenInvalidError)
          (err as any).statusCode = 401;
        throw err;
      }
    })().finally(() => {
      if (refreshRevision === startedRevision) refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

/** Verify a candidate without replacing the last known-good stored credential. */
export async function verifyCandidateSessionToken(
  sessionToken: string,
  turnstileToken?: string,
): Promise<{
  credentials: SessionCredentials;
  persistedSessionToken: string;
  expiresAt: number;
  turnstileToken?: string;
}> {
  const minted = await mintAccessToken(sessionToken);
  const prior = getSession();
  // The device id represents this Mirror installation, not one spelling of
  // a rotating session cookie. Keep it stable across successful rotations.
  const isSameSession = Boolean(prior);
  const effectiveTurnstile = turnstileToken;
  return {
    credentials: {
      accessToken: minted.accessToken,
      deviceId: (isSameSession ? prior?.deviceId : undefined) ?? randomUUID(),
      sessionToken: minted.rotatedSessionToken ?? sessionToken,
    },
    persistedSessionToken: minted.rotatedSessionToken ?? sessionToken,
    expiresAt: minted.expiresAt,
    turnstileToken: effectiveTurnstile,
  };
}
