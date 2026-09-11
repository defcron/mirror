/**
 * Cloudflare Turnstile token resolution and browser-based challenge solver for Sentinel.
 *
 * When Sentinel requirements indicate `turnstile: { required: true, dx: "..." }`,
 * the client needs a valid Turnstile response token for `/sentinel/chat-requirements/finalize`
 * and `/f/conversation`.
 *
 * This module provides:
 * 1. An in-memory TTL cache for Turnstile tokens.
 * 2. Token resolution pipeline across overrides, session credentials, env vars, cache, and solvers.
 * 3. Headless browser solver driving Playwright/Chromium to render Sentinel's `frame.html` or
 *    intercept the Turnstile response from ChatGPT's Cloudflare flow.
 */

/**
 * The two declarations below exist purely so the closure passed to
 * Playwright's `page.evaluate()` further down typechecks: that callback is
 * serialized and executed inside the headless page's own real browser
 * context at runtime (real `document`/`window` there), not by this
 * package's own Node/TS build - and this package's tsconfig intentionally
 * has no DOM lib (it's a Node package). Purely a type-level shim; no
 * runtime behavior changes.
 */
declare const document: any;
declare const window: any;

export interface TurnstileChallenge {
  required: boolean;
  dx?: string | null;
  frameUrl?: string | null;
}

export interface TurnstileTokenCacheEntry {
  token: string;
  expiresAt: number;
}

export interface BrowserTurnstileOptions {
  origin?: string;
  frameUrl?: string;
  sessionToken?: string | null;
  deviceId?: string | null;
  dx?: string | null;
  timeoutMs?: number;
  playwright?: any;
  signal?: AbortSignal;
  args?: string[];
  noSandbox?: boolean;
}

export interface ResolveTurnstileOptions {
  required: boolean;
  dx?: string | null;
  frameUrl?: string | null;
  overrideToken?: string | null;
  credentialsToken?: string | null;
  sessionToken?: string | null;
  deviceId?: string | null;
  signal?: AbortSignal;
  solver?: ((challenge: TurnstileChallenge) => Promise<string | null> | string | null) | null;
}

let cachedTurnstile: TurnstileTokenCacheEntry | null = null;

export function getCachedTurnstileToken(now = Date.now()): string | null {
  if (cachedTurnstile && cachedTurnstile.expiresAt > now) {
    return cachedTurnstile.token;
  }
  cachedTurnstile = null;
  return null;
}

export function setCachedTurnstileToken(token: string, ttlMs = 240_000, now = Date.now()): void {
  cachedTurnstile = {
    token,
    expiresAt: now + ttlMs,
  };
}

export function clearCachedTurnstileToken(): void {
  cachedTurnstile = null;
}

export function decodeTurnstileConfig(dx: string | null | undefined): unknown[] | null {
  if (!dx || !dx.includes("gAAAAAB")) return null;
  const afterMarker = dx.split("gAAAAAB", 2)[1];
  if (!afterMarker) return null;
  let encoded = afterMarker.split("~", 1)[0];
  const pad = (4 - (encoded.length % 4)) % 4;
  encoded += "=".repeat(pad);
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function solveTurnstileWithBrowser(
  opts: BrowserTurnstileOptions = {},
): Promise<string | null> {
  const origin = opts.origin ?? "https://chatgpt.com";
  const frameUrl = opts.frameUrl ?? `${origin}/backend-api/sentinel/frame.html`;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  try {
    let pw = opts.playwright;
    if (!pw) {
      try {
        const mod = await import("playwright");
        pw = mod.chromium ? mod : (mod.default ?? mod);
      } catch {
        return null;
      }
    }
    const chromium = pw.chromium;
    if (!chromium || typeof chromium.launch !== "function") return null;

    const launchArgs = opts.args ? [...opts.args] : ["--disable-dev-shm-usage"];
    if (opts.noSandbox || (typeof process !== "undefined" && process.env?.MIRROR_TURNSTILE_NO_SANDBOX === "true")) {
      launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
    }
    const browser = await chromium.launch({
      headless: true,
      args: launchArgs,
    });

    try {
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      });

      if (opts.sessionToken) {
        await context.addCookies([
          {
            name: "__Secure-next-auth.session-token",
            value: opts.sessionToken,
            domain: new URL(origin).hostname,
            path: "/",
            httpOnly: true,
            secure: true,
            sameSite: "Lax",
          },
        ]);
      }

      const page = await context.newPage();
      let capturedToken: string | null = null;

      page.on("request", (req: any) => {
        try {
          const headers = req.headers?.() ?? {};
          if (headers["openai-sentinel-turnstile-token"]) {
            capturedToken = headers["openai-sentinel-turnstile-token"];
          }
          const postData = req.postData?.();
          if (postData && typeof postData === "string" && postData.includes('"turnstile"')) {
            const parsed = JSON.parse(postData);
            if (typeof parsed.turnstile === "string") {
              capturedToken = parsed.turnstile;
            }
          }
        } catch {}
      });

      page.on("response", async (res: any) => {
        try {
          const headers = res.headers?.() ?? {};
          if (headers["openai-sentinel-turnstile-token"]) {
            capturedToken = headers["openai-sentinel-turnstile-token"];
          }
        } catch {}
      });

      const navPromise = page.goto(frameUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
      const abortPromise = new Promise<null>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(null), { once: true });
      });

      await Promise.race([navPromise, abortPromise]);
      if (opts.signal?.aborted) {
        await browser.close().catch(() => {});
        return null;
      }

      if (!capturedToken) {
        const domToken = await page.evaluate(() => {
          try {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input?.value) return input.value;
            const w = window as any;
            if (typeof w?.turnstile?.getResponse === "function") {
              const resp = w.turnstile.getResponse();
              if (resp) return String(resp);
            }
          } catch {}
          return null;
        }).catch(() => null);

        if (domToken && typeof domToken === "string") {
          capturedToken = domToken;
        }
      }

      await browser.close().catch(() => {});
      if (capturedToken) {
        setCachedTurnstileToken(capturedToken);
      }
      return capturedToken;
    } catch {
      await browser.close().catch(() => {});
      return null;
    }
  } catch {
    return null;
  }
}

export async function resolveTurnstileToken(
  opts: ResolveTurnstileOptions,
): Promise<string | null> {
  if (opts.overrideToken) return opts.overrideToken;
  if (opts.credentialsToken) return opts.credentialsToken;

  const envToken =
    (typeof process !== "undefined" && process.env?.CHATGPT_TURNSTILE_TOKEN) ||
    (typeof process !== "undefined" && process.env?.MIRROR_TURNSTILE_TOKEN) ||
    null;
  if (envToken) return envToken;

  const cached = getCachedTurnstileToken();
  if (cached) return cached;

  if (opts.solver) {
    try {
      const solved = await opts.solver({
        required: opts.required,
        dx: opts.dx,
        frameUrl: opts.frameUrl,
      });
      if (solved) {
        setCachedTurnstileToken(solved);
        return solved;
      }
    } catch {}
  }

  if (opts.required) {
    const browserToken = await solveTurnstileWithBrowser({
      frameUrl: opts.frameUrl ?? undefined,
      sessionToken: opts.sessionToken,
      deviceId: opts.deviceId,
      dx: opts.dx,
      signal: opts.signal,
    });
    if (browserToken) return browserToken;
  }

  return null;
}
