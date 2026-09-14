/**
 * Private-protocol drift classification (MIR-31, NEXT-STEPS.md section 3).
 *
 * ChatGPT's backend-api is unversioned and can change shape without notice -
 * that is Mirror's single biggest ongoing risk. When a call into it fails,
 * this turns the failure into one of four sanitized categories (the exact
 * ones NEXT-STEPS.md calls for) instead of a generic 502, so a real protocol
 * drift is immediately distinguishable from an expired session or a normal
 * upstream hiccup - without ever inspecting or retaining the actual
 * response body, which may contain account-specific content.
 *
 * This is deliberately just the classification half of MIR-31. The other
 * half - a schema-tolerant, sanitized capture/replay fixture format with
 * provenance metadata (capture date, endpoint, sanitization version) - is
 * still open; see TODO.md.
 */

import { BackendApiError } from "./types.js";
import { SessionTokenInvalidError } from "./session.js";

export type ProtocolDriftCategory =
  | "authentication-challenge"
  | "transport-truncation"
  | "known-upstream-error"
  | "unsupported-shape"
  | "unknown";

export interface ClassifiedDrift {
  category: ProtocolDriftCategory;
  /** A short, sanitized note - never the raw upstream body. */
  note: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies a failure raised while talking to chatgpt.com/backend-api.
 * Order matters: check the most specific/actionable category first.
 */
export function classifyProtocolFailure(error: unknown): ClassifiedDrift {
  const message = messageOf(error);
  const status = error instanceof BackendApiError ? error.status : undefined;

  if (
    error instanceof SessionTokenInvalidError ||
    status === 401 ||
    status === 403 ||
    message.includes("turnstile") ||
    message.includes("Turnstile") ||
    message.includes("challenge")
  ) {
    return {
      category: "authentication-challenge",
      note: "The session was rejected or ChatGPT is demanding an interactive challenge Mirror could not satisfy. Reconnect the session or complete the challenge in a real browser.",
    };
  }

  if (
    message.includes("stream interrupted") ||
    message.includes("stream returned error_code")
  ) {
    return message.includes("error_code")
      ? {
          category: "known-upstream-error",
          note: "ChatGPT's own stream reported an error_code rather than completing normally - not a Mirror parsing failure.",
        }
      : {
          category: "transport-truncation",
          note: "The connection to ChatGPT closed before the stream reached a terminal event. Treat any partial answer as unconfirmed, not successful.",
        };
  }

  if (
    message.startsWith("Unsupported ") ||
    message.includes("returned non-object JSON") ||
    message.includes("no assistant node was received")
  ) {
    return {
      category: "unsupported-shape",
      note: "backend-api returned a response shape Mirror's protocol layer doesn't recognize - a likely sign the private protocol changed. Attach a sanitized capture, not the raw payload, when reporting this.",
    };
  }

  return {
    category: "unknown",
    note: "Not one of the recognized drift categories; treat as an ordinary failure unless it recurs.",
  };
}
