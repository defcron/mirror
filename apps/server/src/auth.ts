import { mintAccessToken, SessionTokenInvalidError, type SessionCredentials } from "@mirror/protocol";
import { getSession, updateMintedToken } from "./store.js";
import { randomUUID } from "node:crypto";

const REFRESH_BUFFER_MS = 60_000; // re-mint a bit before actual expiry, not right at the edge

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
    return { accessToken: session.cachedAccessToken!, deviceId: session.deviceId };
  }

  try {
    const minted = await mintAccessToken(session.sessionToken);
    updateMintedToken(minted.accessToken, minted.expiresAt, minted.rotatedSessionToken);
    return { accessToken: minted.accessToken, deviceId: session.deviceId };
  } catch (err) {
    if (err instanceof SessionTokenInvalidError) {
      (err as any).statusCode = 401;
    }
    throw err;
  }
}

/** Verify a candidate without replacing the last known-good stored credential. */
export async function verifyCandidateSessionToken(sessionToken: string): Promise<{
  credentials: SessionCredentials;
  persistedSessionToken: string;
  expiresAt: number;
}> {
  const minted = await mintAccessToken(sessionToken);
  const prior = getSession();
  return {
    credentials: { accessToken: minted.accessToken, deviceId: prior?.deviceId ?? randomUUID() },
    persistedSessionToken: minted.rotatedSessionToken ?? sessionToken,
    expiresAt: minted.expiresAt,
  };
}
