/**
 * Cloudflare Turnstile token resolution and browser-based challenge fallback.
 * Tokens returned here belong only to the current Sentinel finalize call.
 */

declare const document: any;
declare const window: any;

export interface TurnstileChallenge {
  required: boolean;
  dx?: string | null;
  frameUrl?: string | null;
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

export interface ResolveTurnstileOptions extends TurnstileChallenge {
  overrideToken?: string | null;
  credentialsToken?: string | null;
  sessionToken?: string | null;
  deviceId?: string | null;
  signal?: AbortSignal;
  solver?: ((challenge: TurnstileChallenge) => Promise<string | null> | string | null) | null;
  browserSolver?: ((options: BrowserTurnstileOptions) => Promise<string | null>) | null;
}

export function decodeTurnstileConfig(dx: string | null | undefined): unknown[] | null {
  if (!dx || !dx.includes("gAAAAAB")) return null;
  const afterMarker = dx.split("gAAAAAB", 2)[1];
  if (!afterMarker) return null;
  let encoded = afterMarker.split("~", 1)[0];
  encoded += "=".repeat((4 - (encoded.length % 4)) % 4);
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function solveTurnstileWithBrowser(
  opts: BrowserTurnstileOptions = {},
): Promise<string | null> {
  if (opts.signal?.aborted) return null;
  const origin = opts.origin ?? "https://chatgpt.com";
  const frameUrl = opts.frameUrl ?? `${origin}/backend-api/sentinel/frame.html`;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  try {
    let pw = opts.playwright;
    if (!pw) {
      pw = await import("playwright");
    }
    const chromium = pw?.chromium;
    if (!chromium || typeof chromium.launch !== "function") return null;
    const launchArgs = opts.args ? [...opts.args] : ["--disable-dev-shm-usage"];
    if (opts.noSandbox || (typeof process !== "undefined" && process.env?.MIRROR_TURNSTILE_NO_SANDBOX === "true"))
      launchArgs.push("--no-sandbox", "--disable-setuid-sandbox");
    const browser = await chromium.launch({ headless: true, args: launchArgs });
    const run = async (): Promise<string | null> => {
      if (opts.signal?.aborted) return null;
      const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        ...(opts.deviceId ? { extraHTTPHeaders: { "oai-device-id": opts.deviceId } } : {}),
      });
      if (opts.sessionToken) {
        await context.addCookies([{
          name: "__Secure-next-auth.session-token", value: opts.sessionToken,
          domain: new URL(origin).hostname, path: "/", httpOnly: true,
          secure: true, sameSite: "Lax",
        }]);
      }
      const page = await context.newPage();
      let capturedToken: string | null = null;
      page.on("request", (req: any) => {
        try {
          const headers = req.headers();
          if (headers["openai-sentinel-turnstile-token"])
            capturedToken = headers["openai-sentinel-turnstile-token"];
          const postData = req.postData();
          if (postData && typeof postData === "string" && postData.includes('"turnstile"')) {
            const parsed = JSON.parse(postData);
            if (typeof parsed.turnstile === "string") capturedToken = parsed.turnstile;
          }
        } catch {}
      });
      page.on("response", async (res: any) => {
        try {
          const headers = res.headers();
          if (headers["openai-sentinel-turnstile-token"])
            capturedToken = headers["openai-sentinel-turnstile-token"];
        } catch {}
      });
      let abort: (() => void) | undefined;
      const abortPromise = new Promise<null>((resolve) => {
        if (opts.signal?.aborted) return resolve(null);
        abort = () => resolve(null);
        opts.signal?.addEventListener("abort", abort, { once: true });
      });
      try {
        await Promise.race([
          page.goto(frameUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" }),
          abortPromise,
        ]);
      } finally {
        opts.signal?.removeEventListener("abort", abort!);
      }
      if (opts.signal?.aborted) return null;
      if (!capturedToken) {
        const domToken = await page.evaluate(() => {
          try {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input?.value) return input.value;
            const turnstile = (window as any)?.turnstile;
            if (typeof turnstile?.getResponse === "function") {
              const response = turnstile.getResponse();
              if (response) return String(response);
            }
          } catch {}
          return null;
        }).catch(() => null);
        if (domToken && typeof domToken === "string") capturedToken = domToken;
      }
      return capturedToken;
    };
    const result = await run().catch(() => null);
    await browser.close().catch(() => {});
    return result;
  } catch {
    return null;
  }
}

export async function resolveTurnstileToken(opts: ResolveTurnstileOptions): Promise<string | null> {
  if (opts.signal?.aborted || !opts.required) return null;
  if (opts.overrideToken) return opts.overrideToken;
  if (opts.credentialsToken) return opts.credentialsToken;
  if (opts.solver) {
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(opts.signal!.reason);
        opts.signal?.addEventListener("abort", abort, { once: true });
      });
      const solved = await Promise.race([
        Promise.resolve(opts.solver({ required: true, dx: opts.dx, frameUrl: opts.frameUrl })),
        cancelled,
      ]);
      if (solved) return solved;
    } catch (error) {
      if (opts.signal?.aborted) throw error;
    } finally {
      if (abort) opts.signal?.removeEventListener("abort", abort);
    }
  }
  const browserSolver = opts.browserSolver ?? solveTurnstileWithBrowser;
  return browserSolver({
    frameUrl: opts.frameUrl ?? undefined,
    sessionToken: opts.sessionToken,
    deviceId: opts.deviceId,
    dx: opts.dx,
    signal: opts.signal,
  });
}
