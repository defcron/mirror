/**
 * Startup preflight classification (MIR-35).
 *
 * Mirror's actual startup sequence (see the entrypoint block at the bottom of
 * `index.ts`) is: build the app (config parsing, master-key/`MIRROR_STORE_KEY`
 * decoding, database open + migration) -> verify required WARP egress -> bind
 * the HTTP listener. Each of those three phases fails in a recognizably
 * different way today; this module turns whichever one throws into one short,
 * actionable line instead of a raw stack trace, so a failed `npm start` (or
 * a failed container boot) says what to actually do next rather than just
 * where in the code it happened.
 *
 * Deliberately scoped to what can actually throw during *this* startup path.
 * A missing Playwright/Chromium browser (used lazily, only when a live
 * Turnstile challenge needs solving) and an expired ChatGPT session token
 * (only discovered on the first proxied/API request) are both real failure
 * modes, but neither one happens at boot in the current code - they already
 * surface through `GET /api/diagnostics` (MIR-09) with their own next-action
 * text once a request actually hits them. Claiming to preflight-check those
 * here would be checking something Mirror doesn't actually check yet.
 */

export type StartupFailureCategory =
  | "configuration"
  | "database-migration"
  | "warp-egress"
  | "port-in-use"
  | "unknown";

export interface ClassifiedStartupFailure {
  category: StartupFailureCategory;
  message: string;
  nextAction: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Node sets `.code` on the `Error` for OS-level failures like a bound port. */
function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function classifyStartupFailure(error: unknown): ClassifiedStartupFailure {
  const message = messageOf(error);
  const code = codeOf(error);

  if (code === "EADDRINUSE") {
    return {
      category: "port-in-use",
      message,
      nextAction:
        "Another process is already using this port. Stop it, or set PORT (direct run) / MIRROR_PORT (Compose) to a free one.",
    };
  }

  if (message.includes("Mirror requires WARP")) {
    return {
      category: "warp-egress",
      message,
      nextAction:
        "Confirm the bundled WARP container is running and WARP_ACCEPT_TOS=yes is set, then restart. Mirror will not fall back to a direct connection.",
    };
  }

  if (
    message.includes("Unsupported database schema version") ||
    message.includes("database schema")
  ) {
    return {
      category: "database-migration",
      message,
      nextAction:
        "This database was created by a newer Mirror release. Restore a compatible backup or upgrade Mirror - see RELEASE-RECOVERY.md.",
    };
  }

  if (
    message.includes("MIRROR_STORE_KEY") ||
    message.includes("must decode to exactly 32 bytes")
  ) {
    return {
      category: "configuration",
      message,
      nextAction:
        "Fix MIRROR_STORE_KEY in your environment - it must be 32 bytes, base64 or hex-encoded - or unset it to let Mirror generate one.",
    };
  }

  return {
    category: "unknown",
    message,
    nextAction:
      "Check the full error above; if it keeps happening, open an issue with this message (it has already been kept free of credentials/tokens).",
  };
}

/** Renders a `classifyStartupFailure` result as the one block of text Mirror
 * actually prints to stderr on a failed boot. */
export function formatStartupFailure(error: unknown): string {
  const { category, message, nextAction } = classifyStartupFailure(error);
  return `mirror failed to start [${category}]: ${message}\nNext step: ${nextAction}`;
}
