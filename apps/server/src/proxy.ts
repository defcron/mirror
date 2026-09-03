import type { FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { getValidCredentials } from "./auth.js";
import { getSession, setSessionAccountId } from "./store.js";
import { isRewritableContentType, requestOrigin, rewriteChatGptUrls } from "./url-rewrite.js";
import { isAllowedOrigin, isAllowedRequestHost } from "./security.js";

// Datadog's Browser SDK is configured (on OpenAI's side, in their Datadog
// dashboard) with an "allowed application URLs" list scoped to chatgpt.com --
// it has no awareness of, or way to be told about, a proxy origin like ours,
// so it always logs "SDK initialized on a non-allowed domain" when loaded
// from here and simply refuses to collect anything. There is no client-side
// config we can pass to satisfy that check; it is resolved against Datadog's
// own dashboard settings for the real site, not anything in the page itself.
// Since it never actually collects data through our proxy anyway (and
// proxying our users' session activity to OpenAI's own analytics vendor is
// not something we want regardless), the simplest and most correct fix is to
// strip Datadog's script tags out of the served HTML entirely so the SDK
// never loads and never runs that check in the first place.
// NOTE: an earlier version of this matched any <script> tag whose full text
// (including inline body content) contained "datadog" or "dd_rum". That was
// too broad -- the app's own client-bootstrap script embeds a JSON config
// blob that lists "datadog" among other integration/feature names, so that
// heuristic deleted the real bootstrap script itself, breaking the app with
// "missing client-bootstrap script". Only strip <script src="..."> tags that
// actually point at a Datadog-owned host; never touch inline script bodies.
const DATADOG_SRC_SCRIPT_TAG = /<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*>\s*<\/script>|<script\b[^>]*\bsrc=["'][^"']*datadoghq[^"']*["'][^>]*\/>/gi;
function stripDatadogScripts(html: string): string {
  return html.replace(DATADOG_SRC_SCRIPT_TAG, "");
}

// The real cause of the "SDK initialized on a non-allowed domain" console
// error: Datadog's Browser SDK is bundled directly into ChatGPT's own lazily
// loaded JS chunks (not a separate <script src> at all), and its domain check
// compares `location.origin` against an `allowedTrackingOrigins` array baked
// into the app's own RUM init call. Patching that array in the served JS text
// (a previous version of this fix) DID reach the SDK -- confirmed live via
// its own getInitConfiguration() -- but the error persisted anyway, which
// points at an init-timing race: something calls into the RUM API (addAction)
// before the app's own bootstrap ever calls init(), triggering a defensive
// "self-heal" init call inside the SDK itself that we don't control the
// timing or exact arguments of.
//
// So instead of trying to win that race by patching the app's own call, we
// suppress the app's automatic init() call entirely -- `false&&x.init({...})`
// short-circuits before the call (and its argument object) is ever evaluated,
// anchored on the init call's argument signature rather than the minified
// receiver variable name so it survives ChatGPT deploys renaming that
// variable -- and instead call the real init() ourselves, once, from
// EARLY_PATCH client-side, at a time we control (after window "load", well
// past the early race), with our own config that can't fail the domain check.
// See EARLY_PATCH's mirrorInitDatadog() below for the actual call.
const DATADOG_INIT_CALL_PATTERN = /([$\w]+\.init\(\{applicationId:)/g;
function disableDatadogInit(text: string): string {
  return text.replace(DATADOG_INIT_CALL_PATTERN, "false&&$1");
}

const UPSTREAM = "https://chatgpt.com";
// Kept in sync with a real browser's actual reported version (checked against
// a live HAR capture) rather than left stale -- a User-Agent claiming a much
// older Chrome than what the rest of the request's fingerprint implies is
// itself a mismatch signal, on top of the Node/undici TLS fingerprint always
// being different from a real browser's regardless of what this string says.
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"';
// Syntactically valid, unsigned, non-secret JWT. The official client decodes
// expiry/subject locally; the proxy always discards it before upstream calls.
const BROWSER_TOKEN = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6Im1pcnJvci11c2VyIn0.";
const websocketServer = new WebSocketServer({ noServer: true });
const MAX_PENDING_WEBSOCKET_MESSAGES = 100;
const MAX_PENDING_WEBSOCKET_BYTES = 1024 * 1024;

// Previously this was a static <link>/<script defer> pair spliced directly
// into the served HTML head. That worked, but left extra <head> children
// present during the app's own hydration pass. If the app hydrates starting
// from document/html rather than only the body root, React compares the
// live DOM against what its own server render produced, and nodes we
// injected that it never rendered do not match -- a very plausible cause of
// the hydration RecoverableError (minified React error #418) seen in the
// console even though nothing was actually broken. EARLY_PATCH now creates
// and appends these elements itself after window "load", well after
// hydration has settled, instead of them being present in the initial
// parsed document at all.

/**
 * The upstream bundle bakes absolute `https://chatgpt.com/...` URLs into its
 * fetch/XHR/WebSocket calls instead of using paths relative to the page's own
 * origin. When that HTML is served from our proxy's origin, those calls become
 * real cross-origin requests that chatgpt.com's CORS policy rejects outright
 * (no Access-Control-Allow-Origin for our origin) -- this is NOT fixable with
 * CORS headers on our own server, since our server is never in the loop for
 * those requests at all. Instead we rewrite them back to same-origin, client
 * side, before they're sent, so they hit our proxy (which already forwards
 * any path to upstream) instead of the real chatgpt.com host directly.
 *
 * This MUST run before any of the app's own bundle code does, so it's injected
 * as a blocking (non-deferred, non-async) inline script as the very first
 * thing inside <head> -- earlier than the deferred INJECT script above and
 * earlier than any of the page's own <script> tags, which either come later in
 * the document or are themselves deferred/async/module (which always run
 * after synchronous parsing completes).
 */
const EARLY_PATCH = `<script>(function(){
// Install the Datadog init hook (see mirrorInitDatadog/installMirrorDatadogHook
// further down) as the very first thing this script does, before rel()/
// wrapFetch/etc are even defined -- confirmed via a temporary stack-capturing
// console.error hook that the app's own "addAction before initialize"
// self-heal path can fire and lose the domain check before window "load"
// ever arrives, so deferring our own real init() call to window "load" only
// won the race sometimes. Hooking the window.DD_RUM property itself, so our
// init() runs synchronously the instant the app assigns it, wins every time
// regardless of how early the app pokes it.
installMirrorDatadogHook();
function rel(u){
  try{
    if(typeof u!=="string") return u;
    var x=new URL(u,location.href);
    if(x.hostname==="chatgpt.com"||x.hostname.endsWith(".chatgpt.com")||x.hostname==="chat.openai.com"){
      x.protocol=location.protocol;
      x.host=location.host;
      return x.href;
    }
  }catch(e){}
  return u;
}
function wrapFetch(delegate){
  var wrapped=function(input,init){
    try{
      if(typeof input==="string")input=rel(input);
      else if(input instanceof URL)input=rel(input.href);
      else if(input&&typeof input==="object"&&typeof input.url==="string"){
        var rewritten=rel(input.url);
        if(rewritten!==input.url){
          // Reconstruct fetch options explicitly instead of cloning Request.
          // A Request carrying a streaming/consumed body can throw when used as
          // the init argument to another Request, which previously caused the
          // catch path to send the original cross-origin URL unchanged.
          var base={
            method:input.method,headers:input.headers,mode:input.mode,
            credentials:input.credentials,cache:input.cache,redirect:input.redirect,
            referrer:input.referrer,referrerPolicy:input.referrerPolicy,
            integrity:input.integrity,keepalive:input.keepalive,signal:input.signal
          };
          if(input.method!=="GET"&&input.method!=="HEAD"){
            // Earlier versions handed a live ReadableStream (input.clone().body)
            // to the reconstructed Request, with an unconditional duplex:"half".
            // That actually broke these requests outright: Chrome's fetch only
            // allows a ReadableStream upload body over a connection it can
            // multiplex (h2/h3), and our proxy is plain HTTP/1.1 -- Chrome's
            // attempt to satisfy that requirement by negotiating an alternate
            // protocol against our origin is exactly what surfaced as
            // net::ERR_ALPN_NEGOTIATION_FAILED on every one of these POSTs
            // (Statsig's telemetry beacon, /backend-api/f/conversation/prepare,
            // composer interaction logging, ...) -- a real, hard failure, not
            // just console noise. A fully-buffered body (ArrayBuffer) needs no
            // duplex option and no streaming upload support at all, so we read
            // the clone to completion here instead of handing over its stream.
            // This does mean the rewrite path is now async; wrapped becomes an
            // async function below, which still satisfies fetch's contract of
            // "returns a Promise that resolves to a Response".
            return input.clone().arrayBuffer().then(function(buf){
              base.body=buf;
              if(init)for(var key in init)base[key]=init[key];
              return delegate.call(this,rewritten,base);
            }.bind(this));
          }
          if(init)for(var key in init)base[key]=init[key];
          input=rewritten;init=base;
        }
      }
    }catch(e){}
    return delegate.call(this,input,init);
  };
  try{Object.defineProperty(wrapped,"__mirrorProxyPatch",{value:true});}catch(e){}
  return wrapped;
}
var currentFetch=window.fetch;
if(currentFetch){
  var patchedFetch=wrapFetch(currentFetch);
  try{
    Object.defineProperty(window,"fetch",{
      // ChatGPT's instrumentation replaces (and sometimes deletes) fetch while
      // booting. Keep this accessor in place so every replacement is wrapped.
      configurable:false,enumerable:true,
      get:function(){return patchedFetch;},
      set:function(next){
        if(typeof next==="function"&&!next.__mirrorProxyPatch){
          currentFetch=next;
          patchedFetch=wrapFetch(next);
        }
      }
    });
  }catch(e){window.fetch=patchedFetch;}
}
var open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  var args=Array.prototype.slice.call(arguments);
  try{if(typeof url==="string")args[1]=rel(url);}catch(e){}
  try{if(typeof url==="string"&&url.indexOf("prepare")!==-1){window.__mirrorDebugXhr=window.__mirrorDebugXhr||[];window.__mirrorDebugXhr.push({method:method,url:url});}}catch(e){}
  return open.apply(this,args);
};
var OrigWorker=window.Worker;
if(OrigWorker){
  window.Worker=function(url,opts){
    try{window.__mirrorWorkers=window.__mirrorWorkers||[];window.__mirrorWorkers.push(String(url));}catch(e){}
    try{url=rel(String(url));}catch(e){}
    return opts!==undefined?new OrigWorker(url,opts):new OrigWorker(url);
  };
  window.Worker.prototype=OrigWorker.prototype;
}
var sb=navigator.sendBeacon;
if(sb)navigator.sendBeacon=function(url,data){try{if(typeof url==="string")url=rel(url);}catch(e){}return sb.call(navigator,url,data);};
var WS=window.WebSocket;
if(WS){
  var W2=function(url,protocols){
    try{
      if(typeof url==="string")url=rel(url).replace(/^https:/,"wss:").replace(/^http:/,"ws:");
    }catch(e){}
    return protocols!==undefined?new WS(url,protocols):new WS(url);
  };
  W2.prototype=WS.prototype;
  window.WebSocket=W2;
}
// Remove this script's own node from <head> immediately after it has run.
// It has already installed its patches via closures/property overrides at
// this point, so the DOM node itself serves no further purpose -- but left
// in place it is one more unexpected <head> child during the app's own
// hydration pass (see the comment above the removed INJECT constant).
try{
  if(document.currentScript&&document.currentScript.parentNode){
    document.currentScript.parentNode.removeChild(document.currentScript);
  }
}catch(e){}
function mirrorAddInjectAssets(){
  try{
    var l=document.createElement("link");
    l.rel="stylesheet";l.href="/mirror/inject.css";
    var s=document.createElement("script");
    s.defer=true;s.src="/mirror/inject.js";
    var head=document.head||document.documentElement;
    head.appendChild(l);
    head.appendChild(s);
  }catch(e){}
}
if(document.readyState==="complete"){
  mirrorAddInjectAssets();
}else{
  window.addEventListener("load",mirrorAddInjectAssets,{once:true});
}
// The app's own automatic Datadog init() call is suppressed server-side
// (disableDatadogInit, above) to dodge an init-timing race in their bundle.
// We make the real call ourselves instead, deliberately deferred to well
// after that race window, using values read straight out of today's bundle
// (applicationId/clientToken/site/service/env) plus an allowedTrackingOrigins
// that matches any origin so the domain check this whole detour exists to
// avoid can never fail. If a future ChatGPT deploy rotates these values this
// stops matching and Datadog just stays off, same as before this fix --
// never a hard failure either way.
function mirrorInitDatadogOn(dd){
  try{
    if(!dd||typeof dd.init!=="function"||typeof dd.getInitConfiguration!=="function")return;
    if(dd.getInitConfiguration())return;
    dd.init({
      applicationId:"fd6e06b8-4825-4fbb-8db4-2a243f92c4bc",
      clientToken:"pub1f79f8ac903a5872ae5f53026d20a77c",
      site:"datadoghq.com",
      service:"chatgpt-web",
      env:"prod",
      allowedTrackingOrigins:[/^/],
      sessionSampleRate:1,
      sessionReplaySampleRate:0,
      trackUserInteractions:false
    });
  }catch(e){}
}
function installMirrorDatadogHook(){
  try{
    var current=window.DD_RUM;
    // If the app already assigned window.DD_RUM before we got here (it
    // shouldn't, since this runs first, but be defensive), init it right now.
    if(current)mirrorInitDatadogOn(current);
    Object.defineProperty(window,"DD_RUM",{
      configurable:true,enumerable:true,
      get:function(){return current;},
      set:function(next){
        current=next;
        // Call synchronously, in the same tick as the assignment, before
        // whatever assigned it gets a chance to run any further code (like
        // the app's own addAction-before-initialize self-heal) that would
        // otherwise race us to calling the real init() first.
        mirrorInitDatadogOn(next);
      }
    });
    // Datadog's standard bootstrap snippet often does
    // window.DD_RUM=window.DD_RUM||{q:[],onReady:fn} and later MUTATES
    // that same stub object in place (Object.assign-style) once the real SDK
    // chunk loads, rather than reassigning window.DD_RUM to a new object --
    // our property setter above only fires on reassignment, so a mutation
    // would slip past it entirely. Poll the current value's shape for a few
    // seconds after each assignment to catch that case too.
    var pollCount=0;
    var pollTimer=setInterval(function(){
      pollCount++;
      if(pollCount>200){clearInterval(pollTimer);return;}
      if(current&&typeof current.init==="function"&&typeof current.getInitConfiguration==="function"&&!current.getInitConfiguration()){
        mirrorInitDatadogOn(current);
      }
    },5);
  }catch(e){}
}
})();</script>`;

function requestBody(req: FastifyRequest): string | Uint8Array | undefined {
  if (req.method === "GET" || req.method === "HEAD" || req.body == null) return undefined;
  if (typeof req.body === "string" || req.body instanceof Uint8Array) return req.body;
  return JSON.stringify(req.body);
}

function safeRequestHeaders(req: FastifyRequest): Headers {
  const headers = new Headers();
  const exact = new Set([
    "accept", "accept-language", "baggage", "cache-control", "content-type",
    "pragma", "priority", "range", "sentry-trace",
    // These are headers a real Chrome attaches to every request automatically
    // (client-hints + fetch metadata) -- forwarding the browser's own values
    // for them, rather than dropping them on the floor, is strictly better
    // than either omitting them or hand-rolling our own guess: it keeps
    // upstream's view consistent with what the actual requesting browser
    // reports (sec-ch-ua's Chrome version, mobile/platform, etc.) instead of
    // introducing a second, independent mismatch on top of the Node/undici
    // TLS fingerprint we can't fix from here anyway.
    "dnt", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
    "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-user",
    // Chrome sends "gzip, deflate, br, zstd"; Node's fetch defaults to
    // something narrower (no zstd) if we don't forward this ourselves --
    // another small but checkable mismatch. Safe to forward as-is: undici
    // decompresses the response based on the Content-Encoding it actually
    // gets back, regardless of what we advertised accepting.
    "accept-encoding",
  ]);
  const prefixes = ["chatgpt-", "oai-", "openai-", "x-conduit-", "x-oai-", "x-openai-"];
  for (const [rawName, rawValue] of Object.entries(req.headers)) {
    const name = rawName.toLowerCase();
    if (!exact.has(name) && !prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (typeof rawValue === "string") headers.set(name, rawValue);
    else if (Array.isArray(rawValue)) headers.set(name, rawValue.join(", "));
  }
  headers.set("user-agent", USER_AGENT);
  headers.set("origin", UPSTREAM);
  // A real browser sends a deep, page-specific referer (e.g.
  // https://chatgpt.com/c/<conversation-id>) for API calls made from that
  // conversation's page, not a flat "https://chatgpt.com/" for every single
  // request regardless of context -- always sending the bare origin here was
  // its own small, consistently-checkable tell. Rewrite the browser's own
  // Referer (which points at our proxy origin) back to the real upstream
  // host instead, preserving whatever path it actually had.
  const clientReferer = req.headers.referer;
  if (typeof clientReferer === "string") {
    try {
      const rewritten = new URL(clientReferer);
      rewritten.protocol = "https:";
      rewritten.host = new URL(UPSTREAM).host;
      headers.set("referer", rewritten.href);
    } catch {
      headers.set("referer", `${UPSTREAM}/`);
    }
  } else {
    headers.set("referer", `${UPSTREAM}/`);
  }
  // Fall back to our own values only when the browser genuinely didn't send
  // one (e.g. a same-origin GET with no sec-fetch-site, or an older browser
  // without client hints) -- forwarded real values above always win.
  if (!headers.has("sec-ch-ua")) headers.set("sec-ch-ua", SEC_CH_UA);
  if (!headers.has("sec-ch-ua-mobile")) headers.set("sec-ch-ua-mobile", "?0");
  if (!headers.has("sec-ch-ua-platform")) headers.set("sec-ch-ua-platform", '"macOS"');
  return headers;
}

async function mirrorAuthSession(reply: FastifyReply): Promise<void> {
  const credentials = await getValidCredentials();
  const meResponse = await fetch(`${UPSTREAM}/backend-api/me`, {
    headers: {
      accept: "application/json", authorization: `Bearer ${credentials.accessToken}`,
      "oai-device-id": credentials.deviceId, "user-agent": USER_AGENT,
    },
  });
  const me = meResponse.ok ? await meResponse.json().catch(() => ({})) as Record<string, unknown> : {};
  const account = me.account && typeof me.account === "object" ? me.account as Record<string, unknown> : {};
  reply.header("Cache-Control", "no-store").send({
    user: {
      id: String(account.account_user_id ?? me.id ?? "mirror-user"),
      name: String(me.name ?? account.name ?? "ChatGPT user"),
      email: typeof me.email === "string" ? me.email : null,
      // Upstream profile images can be signed URLs; never reflect their query credentials.
      image: null,
    },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    accessToken: BROWSER_TOKEN,
    authProvider: "mirror-session-token",
  });
}

/**
 * Older stored sessions (pre account-id capture) don't have accountId
 * persisted yet. Backfill it lazily from /me on first use so upstream
 * multi-workspace calls (conversations, models) don't silently fall back
 * to a default/limited view.
 */
async function resolveAccountId(credentials: { accessToken: string; deviceId: string }): Promise<string | null> {
  const session = getSession();
  if (session?.accountId) return session.accountId;
  try {
    const meResponse = await fetch(`${UPSTREAM}/backend-api/me`, {
      headers: {
        accept: "application/json", authorization: `Bearer ${credentials.accessToken}`,
        "oai-device-id": credentials.deviceId, "user-agent": USER_AGENT,
      },
    });
    if (!meResponse.ok) return null;
    const me = await meResponse.json().catch(() => ({})) as Record<string, unknown>;
    const account = me.account && typeof me.account === "object" ? me.account as Record<string, unknown> : null;
    const orgs = me.orgs && typeof me.orgs === "object" && Array.isArray((me.orgs as Record<string, unknown>).data)
      ? (me.orgs as Record<string, unknown>).data as unknown[] : [];
    let accountId: string | null = null;
    if (account && typeof account.account_user_id === "string") accountId = account.account_user_id;
    else if (orgs.length > 0 && orgs[0] && typeof orgs[0] === "object" && typeof (orgs[0] as Record<string, unknown>).id === "string") {
      accountId = (orgs[0] as Record<string, unknown>).id as string;
    }
    if (accountId) setSessionAccountId(accountId);
    return accountId;
  } catch {
    return null;
  }
}

/**
 * The upstream frontend opens a raw WebSocket for realtime notifications
 * (e.g. `wss://chatgpt.com/p1/ws/user/...`). Our EARLY_PATCH client-side
 * shim already rewrites that URL to point back at this same-origin server
 * (see the WebSocket constructor patch below), but until now nothing on
 * the server side actually accepted that upgrade -- Fastify's plain HTTP
 * server has no listener for the 'upgrade' event at all, so the TCP
 * handshake just gets dropped and the browser reports a generic
 * "WebSocket connection ... failed". This proxies the upgrade through to
 * the real chatgpt.com WebSocket endpoint, the same way proxyChatGpt()
 * proxies ordinary HTTP requests: same auth headers, same path+query,
 * bytes piped through unmodified in both directions.
 */
export async function proxyWebSocketUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  if (!isAllowedRequestHost(req.headers.host) || !isAllowedOrigin(req.headers.origin, req.headers.host)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const url = req.url ?? "/";
  const upstreamHeaders: Record<string, string> = {
    "user-agent": USER_AGENT,
    origin: UPSTREAM,
  };
  const session = getSession();
  if (session) upstreamHeaders.cookie = `__Secure-next-auth.session-token=${session.sessionToken}`;
  try {
    const credentials = await getValidCredentials();
    upstreamHeaders.authorization = `Bearer ${credentials.accessToken}`;
    upstreamHeaders["oai-device-id"] = credentials.deviceId;
    const accountId = await resolveAccountId(credentials);
    if (accountId) upstreamHeaders["chatgpt-account-id"] = accountId;
  } catch (error) {
    socket.destroy();
    return;
  }

  const upstreamUrl = `${UPSTREAM.replace(/^https:/, "wss:")}${url}`;
  const upstreamSocket = new WebSocket(upstreamUrl, { headers: upstreamHeaders, handshakeTimeout: 15_000 });

  upstreamSocket.on("error", () => socket.destroy());
  upstreamSocket.on("unexpected-response", () => socket.destroy());

  websocketServer.handleUpgrade(req, socket, head, (clientSocket) => {
    const pending: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let pendingBytes = 0;
    let upstreamOpen = false;

    upstreamSocket.on("open", () => {
      upstreamOpen = true;
      for (const message of pending.splice(0)) upstreamSocket.send(message.data, { binary: message.isBinary });
      pendingBytes = 0;
    });
    clientSocket.on("message", (data, isBinary) => {
      if (upstreamOpen) upstreamSocket.send(data, { binary: isBinary });
      else {
        const bytes = typeof data === "string" ? Buffer.byteLength(data) : data instanceof ArrayBuffer ? data.byteLength : Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
        if (pending.length >= MAX_PENDING_WEBSOCKET_MESSAGES || pendingBytes + bytes > MAX_PENDING_WEBSOCKET_BYTES) {
          clientSocket.close(1009, "Pending WebSocket queue limit exceeded");
          upstreamSocket.close();
          return;
        }
        pendingBytes += bytes;
        pending.push({ data, isBinary });
      }
    });
    upstreamSocket.on("message", (data, isBinary) => {
      if (clientSocket.readyState === clientSocket.OPEN) clientSocket.send(data, { binary: isBinary });
    });

    const closeBoth = () => {
      try { clientSocket.close(); } catch { /* already closed */ }
      try { upstreamSocket.close(); } catch { /* already closed */ }
    };
    clientSocket.on("close", closeBoth);
    clientSocket.on("error", closeBoth);
    upstreamSocket.on("close", closeBoth);
    upstreamSocket.on("error", closeBoth);
  });
}

export async function proxyChatGpt(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.url.startsWith("/api/auth/session")) return mirrorAuthSession(reply);

  const headers = safeRequestHeaders(req);
  const wantsHtml = (req.headers.accept ?? "").includes("text/html");
  let htmlAccessToken: string | null = null;
  const session = getSession();
  if (session) {
    headers.set("cookie", `__Secure-next-auth.session-token=${session.sessionToken}`);
    if (wantsHtml) htmlAccessToken = (await getValidCredentials()).accessToken;
  }
  if (req.url.startsWith("/backend-api/")) {
    const credentials = await getValidCredentials();
    headers.set("authorization", `Bearer ${credentials.accessToken}`);
    headers.set("oai-device-id", credentials.deviceId);
    headers.set("x-openai-target-path", req.url.split("?")[0]!);
    headers.set("x-openai-target-route", req.url.split("?")[0]!);
    // The real frontend already sends its own chatgpt-account-id header
    // (safeRequestHeaders forwards it via the "chatgpt-" prefix allowlist)
    // reflecting whatever workspace/org it currently has selected in its own
    // UI state -- unconditionally overwriting that with our once-cached
    // resolveAccountId() value forces every request onto a single account
    // regardless of what the picker/workspace switcher actually shows,
    // which can silently reroute to a different plan/entitlement (and thus a
    // different available model) than the one the UI displays. Only fall
    // back to our resolved id when the frontend didn't send one at all.
    if (!headers.has("chatgpt-account-id")) {
      const accountId = await resolveAccountId(credentials);
      if (accountId) headers.set("chatgpt-account-id", accountId);
    }
  }

  let upstream: Response;
  const controller = new AbortController();
  const abortUpstream = () => controller.abort(new DOMException("Proxy client disconnected", "AbortError"));
  req.raw.once("aborted", abortUpstream);
  reply.raw.once("close", () => { if (!reply.raw.writableEnded) abortUpstream(); });
  try {
    upstream = await fetch(`${UPSTREAM}${req.url}`, {
      method: req.method, headers, body: requestBody(req), redirect: "manual", signal: controller.signal,
    });
  } catch (error) {
    req.log.error({ error, path: req.url }, "mirror upstream request failed");
    reply.code(502).send({ error: "upstream_request_failed", path: req.url });
    return;
  }
  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const proxyOrigin = requestOrigin(req.protocol, req.headers.host);

  reply.hijack();
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    const lowerName = name.toLowerCase();
    if ([
      "alt-svc", "content-encoding", "content-length", "content-security-policy",
      "content-security-policy-report-only", "nel", "report-to",
      "reporting-endpoints", "set-cookie", "strict-transport-security",
      "transfer-encoding", "x-frame-options",
    ].includes(lowerName)) continue;
    responseHeaders[name] = lowerName === "location" && proxyOrigin
      ? rewriteChatGptUrls(value, proxyOrigin)
      : value;
  }
  responseHeaders["content-type"] = contentType;
  // Only fall back to a 5-minute public cache for genuinely static assets
  // (CDN-hosted JS/CSS/images) that don't ship their own cache-control from
  // upstream. Applying that same fallback to /backend-api/* responses --
  // the previous behavior -- let the browser cache things like the models
  // list, conversation state, and gizmo sidebar for up to 5 minutes with no
  // way to bust it, which can surface as exactly this kind of "the picker
  // shows one model but a message actually goes to a different one" staleness
  // once the account's available models/config change mid-session. Live API
  // data always defaults to no-store instead unless upstream explicitly
  // opted it into caching.
  //
  // Text content we actually rewrite (html/js/css/json -- rel() URL rewrites,
  // the Datadog allowedTrackingOrigins patch, etc.) is a special case: this
  // is content whose bytes depend on OUR OWN proxy logic, not just on
  // upstream. Upstream ships hashed CDN filenames with a long, effectively
  // "immutable" cache-control (safe on their end, since that filename's
  // upstream bytes truly never change) -- but that same immutable cache-control
  // passing through us verbatim let the browser go on serving an
  // already-fetched, pre-fix copy of a JS chunk for its full max-age even
  // after we deployed a proxy change that alters what we rewrite that exact
  // chunk into. That's exactly why patches to proxied JS content (like the
  // Datadog domain-check patch) didn't visibly take effect in a browser that
  // had already loaded the unpatched version: the cached response was still
  // "fresh" by HTTP rules and never revisited us at all. So for anything we
  // rewrite, force no-store unconditionally instead of only falling back to
  // it -- this overrides upstream's own cache-control rather than deferring
  // to it, unlike every other header in this response.
  const isStaticAsset = req.url.startsWith("/cdn/");
  const isRewrittenText = contentType.includes("text/html") || isRewritableContentType(contentType);
  responseHeaders["cache-control"] = isRewrittenText
    ? "no-store"
    : !isStaticAsset
      ? responseHeaders["cache-control"] ?? "no-store"
      : responseHeaders["cache-control"] ?? "public, max-age=300";
  // Upstream advertises HTTP/3 via Alt-Svc; forwarding that verbatim tricks Chrome into
  // thinking our plain-HTTP proxy origin also speaks QUIC/h3, causing later requests to
  // fail with net::ERR_ALPN_NEGOTIATION_FAILED when it tries (and fails) to negotiate that
  // protocol. Explicitly sending "clear" (RFC 7838 §4) also purges any such entry the
  // browser already cached from before this fix.
  responseHeaders["alt-svc"] = "clear";
  reply.raw.writeHead(upstream.status, responseHeaders);

  if (contentType.includes("text/html")) {
    let html = await upstream.text();
    // Rewrite the upstream document before injecting EARLY_PATCH. The injected
    // shim intentionally still names the real upstream origin so it can catch
    // dynamically constructed URLs that were not present in the HTML source.
    if (proxyOrigin) html = rewriteChatGptUrls(html, proxyOrigin);
    html = stripDatadogScripts(html);
    if (htmlAccessToken) html = html.split(htmlAccessToken).join(BROWSER_TOKEN);
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${EARLY_PATCH}`) : `${EARLY_PATCH}${html}`;
    reply.raw.end(html);
    return;
  }

  // This is the important worker/module fix. Rewriting only window.fetch is
  // insufficient because worker globals have their own fetch/Request objects.
  // By rewriting JS/JSON/CSS/etc. while proxying the asset, all execution
  // contexts receive same-origin endpoints and therefore route back through
  // this server (which attaches credentials and forwards to ChatGPT).
  if (proxyOrigin && isRewritableContentType(contentType)) {
    let text = rewriteChatGptUrls(await upstream.text(), proxyOrigin);
    text = disableDatadogInit(text);
    reply.raw.end(text);
    return;
  }

  if (!upstream.body) { reply.raw.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (reply.raw.destroyed) break;
      if (!reply.raw.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => {
          const finish = () => { reply.raw.off("drain", finish); reply.raw.off("close", finish); resolve(); };
          reply.raw.once("drain", finish);
          reply.raw.once("close", finish);
        });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (!reply.raw.destroyed) reply.raw.end();
  }
}

export const injectionCss = `
#mirror-launcher{font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ececec;width:100%;position:relative;z-index:2147483647;pointer-events:auto}
#mirror-launcher *{box-sizing:border-box}
#mirror-launcher button{font:inherit}
#mirror-launcher .mirror-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:#ececec;border-radius:8px;padding:8px 10px;cursor:pointer;text-align:left;overflow:hidden}
#mirror-launcher .mirror-row:hover{background:rgba(255,255,255,.08)}
#mirror-launcher .mirror-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mirror-launcher.mirror-compact{width:36px}
#mirror-launcher.mirror-compact .mirror-row{width:36px;height:36px;padding:0;justify-content:center;border-radius:50%}
#mirror-launcher.mirror-compact .mirror-row span:last-child{display:none}
#mirror-launcher .mirror-dot{width:8px;height:8px;border-radius:50%;background:#19c59a;flex:none}
#mirror-launcher .mirror-panel{position:fixed;display:none;z-index:2147483646;width:236px;padding:13px;border:1px solid #404040;border-radius:14px;background:#202020;box-shadow:0 18px 55px #000a}
#mirror-launcher .mirror-panel.open{display:block}
#mirror-launcher .mirror-panel strong,#mirror-launcher .mirror-panel label{display:block;margin-bottom:7px}
#mirror-launcher .mirror-panel p{color:#aaa;font-size:11px}
#mirror-launcher .mirror-panel textarea{width:100%;height:64px;resize:vertical;border:1px solid #444;border-radius:8px;background:#111;color:#eee;padding:8px;font:11px monospace}
#mirror-launcher .mirror-actions{display:flex;gap:7px;margin-top:8px}
#mirror-launcher .mirror-actions button,#mirror-launcher .mirror-actions a{flex:1;border:0;border-radius:8px;padding:8px;text-align:center;text-decoration:none;cursor:pointer}
#mirror-launcher .mirror-save{background:#fff;color:#111}
#mirror-launcher .mirror-play{background:#343434;color:#eee}
#mirror-launcher .mirror-status{min-height:16px;margin-top:6px;color:#9adfce;font-size:11px}
#mirror-launcher .mirror-egress{margin-top:8px;color:#aaa;font-size:11px}
`;

/**
 * Mirror controls widget. Mounted as a normal-flow row inside the sidebar,
 * directly above the account button (data-testid="accounts-profile-button"),
 * so it reads as part of the app chrome rather than a floating overlay.
 * When the sidebar's account button isn't reachable (sidebar collapsed, or
 * this view has no sidebar), the widget is simply hidden -- it must never
 * float over the main content area, since that overlaps and fights with
 * the composer/input for clicks. The widget node itself is kept around
 * (module-level widgetRoot) rather than rebuilt each time, so its state
 * (typed token, open/closed panel) survives hide/show cycles.
 * Since the ChatGPT bundle owns and periodically re-renders these DOM
 * regions (React), a plain one-time insert can get silently wiped on
 * re-render or route change -- so placement is re-asserted on a light
 * interval rather than relying on a single mount call.
 * Also forces the sidebar open once per page load (leaving the user's
 * normal manual collapse/expand alone afterward).
 */
export const injectionJs = `(()=>{
var widgetRoot=null;
function buildWidget(){
  var root=document.createElement('div');
  root.id='mirror-launcher';
  root.innerHTML='<button type="button" class="mirror-row"><span class="mirror-dot"></span><span>Mirror controls</span></button>'
    +'<div class="mirror-panel"><strong>Mirror controls</strong><p>Connect with a sessionToken. The credential stays encrypted on this server and is never inserted into ChatGPT page scripts.</p><label>sessionToken</label><textarea autocomplete="off" spellcheck="false" placeholder="Paste sessionToken"></textarea><div class="mirror-actions"><button class="mirror-save">Save &amp; reload</button><a class="mirror-play" href="/mirror/playground" target="_blank" rel="noopener noreferrer">API tester</a></div><div class="mirror-status"></div><div class="mirror-egress">Egress: checking…</div></div>';
  return root;
}
function getWidget(){if(!widgetRoot)widgetRoot=buildWidget();return widgetRoot;}
function positionPanel(row,panel){
  var r=row.getBoundingClientRect();
  panel.style.left=Math.max(8,Math.round(r.left))+'px';
  panel.style.bottom=Math.round(window.innerHeight-r.top+8)+'px';
}
function openPanel(root){
  var row=root.querySelector('.mirror-row'),panel=root.querySelector('.mirror-panel');
  positionPanel(row,panel);
  panel.classList.add('open');
  var area=root.querySelector('textarea');
  if(area)area.focus();
}
function wireWidget(root){
  if(root.dataset.wired)return;
  root.dataset.wired='1';
  var row=root.querySelector('.mirror-row'),panel=root.querySelector('.mirror-panel'),
      status=root.querySelector('.mirror-status'),area=root.querySelector('textarea');
  row.onclick=function(){
    var willOpen=!panel.classList.contains('open');
    if(willOpen)positionPanel(row,panel);
    panel.classList.toggle('open',willOpen);
  };
  window.addEventListener('resize',function(){if(panel.classList.contains('open'))positionPanel(row,panel);});
  window.addEventListener('scroll',function(){if(panel.classList.contains('open'))positionPanel(row,panel);},true);
  var apiLink=root.querySelector('.mirror-play');
  apiLink.addEventListener('click',function(e){
    e.preventDefault();
    window.open(apiLink.href,'_blank','noopener,noreferrer');
  });
  root.querySelector('.mirror-save').onclick=async function(){
    var token=area.value.trim();if(!token)return;
    status.textContent='Verifying…';
    try{
      var r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionToken:token})});
      var b=await r.json();
      if(!r.ok)throw Error(b.error||'Could not connect');
      area.value='';status.textContent='Connected. Reloading…';location.reload();
    }catch(e){status.textContent=e.message||String(e);}
  };
  fetch('/api/session').then(function(r){return r.json();}).then(function(s){
    root.querySelector('.mirror-dot').style.background=s.configured?'#19c59a':'#e7a83d';
  }).catch(function(){});
  fetch('/api/health').then(function(r){return r.json();}).then(function(h){
    var e=h&&h.egress,el=root.querySelector('.mirror-egress');
    if(!e){el.textContent='Egress: unavailable';return;}
    el.textContent=e.mode==='warp'&&e.verified?'Egress: WARP verified':'Egress: direct';
    el.style.color=e.required&&!e.verified?'#f0a28a':'#aaa';
  }).catch(function(){root.querySelector('.mirror-egress').textContent='Egress: unavailable';});
}
function isReallyVisible(el){
  if(el.offsetParent===null)return false;
  // Only walk ancestors for opacity and display: those two visually/structurally
  // compound down the tree and can never be un-done by a descendant (an
  // ancestor at opacity:0 or display:none makes everything under it
  // genuinely invisible, no override possible). visibility and pointer-events
  // are NOT safe to check this way -- both are routinely reset back by a
  // descendant (e.g. a modal sets pointer-events:none on <body> for a focus
  // trap, then explicitly re-enables pointer-events:auto on the dialog/
  // popover itself), so walking those flagged the real, currently-visible
  // sidebar popover as hidden just because <body> had pointer-events:none.
  var n=el;
  for(var i=0;i<12&&n;i++){
    var cs=getComputedStyle(n);
    if(cs.opacity==='0'||cs.display==='none')return false;
    n=n.parentElement;
  }
  return el.getBoundingClientRect().width>0;
}
function findLoggedOutAnchor(){
  // Logged-out users have no accounts-profile-button in the visible sidebar
  // (only a hidden copy inside the collapsed icon rail, which stays present
  // but invisible in the DOM regardless of login state). Instead the
  // expanded sidebar shows a dedicated "log in" promo pane pinned to its
  // bottom, with a full-width "Log in" button. We anchor above that button
  // instead. There's a second "Log in" button in the top-right page header
  // (shown for logged-out users on every screen) -- that one isn't part of
  // the sidebar chrome at all, so it's explicitly excluded.
  var buttons=document.querySelectorAll('button');
  for(var i=0;i<buttons.length;i++){
    var b=buttons[i];
    if((b.textContent||'').trim()!=='Log in')continue;
    if(b.closest('#page-header'))continue;
    if(!isReallyVisible(b))continue;
    return b;
  }
  return null;
}
function mountInSidebar(){
  // The sidebar's account button can exist in more than one DOM copy at once
  // (a persistent icon-only rail plus a wider overlay/push variant used at
  // other viewport widths or collapse states) -- only one is ever actually
  // shown to the user. offsetParent alone doesn't detect the inactive one,
  // since it's kept in normal layout flow just faded out
  // (opacity:0/pointer-events:none) rather than display:none, so it must be
  // filtered out explicitly or the widget can end up mounted into a hidden
  // copy (never visible) or the wrong-width one (its label gets truncated).
  var accts=document.querySelectorAll('[data-testid="accounts-profile-button"]');
  var acct=null;
  for(var i=0;i<accts.length;i++){if(isReallyVisible(accts[i])){acct=accts[i];break;}}
  var anchor=acct,compactHint=null;
  if(!anchor){
    // Logged out: fall back to anchoring above the sidebar's own "Log in"
    // button instead of the (invisible, in this state) account button.
    anchor=findLoggedOutAnchor();
    compactHint=false; // the login promo pane only ever renders in the expanded sidebar
  }
  if(!anchor)return false;
  var wrapper=anchor.parentElement,container=wrapper&&wrapper.parentElement;
  if(!wrapper||!container)return false;
  var root=getWidget();
  if(root.nextElementSibling!==wrapper||root.parentElement!==container)container.insertBefore(root,wrapper);
  // Prefer a structural check over measuring container width: the account
  // button's own row can overflow wider than its rail ancestor on hover
  // (a flyout-label effect), which makes width alone an unreliable signal
  // for "is this the icon-only rail". #stage-sidebar-tiny-bar is ChatGPT's
  // collapsed icon rail; fall back to a width heuristic if that id ever
  // changes upstream.
  var compact;
  if(compactHint!==null){
    compact=compactHint;
  }else{
    var railAncestor=container.closest('#stage-sidebar-tiny-bar');
    compact=railAncestor?true:container.getBoundingClientRect().width<100;
  }
  root.classList.toggle('mirror-compact',compact);
  wireWidget(root);
  return true;
}
function hideWidget(){
  if(!widgetRoot||!widgetRoot.parentElement)return;
  var panel=widgetRoot.querySelector('.mirror-panel');
  if(panel)panel.classList.remove('open');
  widgetRoot.remove();
}
function tryMount(){if(!mountInSidebar())hideWidget();}
tryMount();
setInterval(tryMount,1000);

// ChatGPT's own "Log in" buttons (sidebar promo pane + top-right header)
// kick off its real OAuth flow, which can't complete through this proxy.
// Redirect clicks on either into our own sessionToken panel instead, so
// logged-out users aren't led down a login path that won't work. Re-scans
// on the same interval as tryMount since React can swap these nodes out.
function interceptLoginButtons(){
  if(!widgetRoot)return;
  var buttons=document.querySelectorAll('button');
  for(var i=0;i<buttons.length;i++){
    var b=buttons[i];
    if(b.dataset.mirrorIntercepted)continue;
    if((b.textContent||'').trim()!=='Log in')continue;
    b.dataset.mirrorIntercepted='1';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
      openPanel(getWidget());
    },true);
  }
}
setInterval(interceptLoginButtons,1000);

// The upstream bundle shows a blocking "Your session has expired" dialog
// (with a full-viewport backdrop) whenever the sessionToken this proxy is
// using no longer validates upstream -- e.g. the user logged out/back in or
// changed security settings on the real chatgpt.com account, rotating the
// token our stored session was minted from. That dialog is real ChatGPT
// chrome expecting its own (non-functional, through this proxy) login flow,
// and its backdrop sits above the sidebar and blocks all clicks/typing,
// including into our own widget -- so the normal fix (open Mirror controls,
// paste a fresh sessionToken) becomes unreachable right when it's needed
// most. We can't "log in" through it, so instead we tear the dialog (and
// its backdrop) out of the DOM whenever it appears, and clear any
// scroll/pointer-events lock it left behind on <html>/<body>, so the page
// -- and our widget -- stay usable. Runs on the same light interval as the
// rest of this shim in case the app re-renders the dialog back in.
function hideEl(el){
  // Neutralize visually AND for hit-testing, without detaching the node from
  // the DOM. React (which owns this whole tree, including Radix's portal
  // nodes) keeps its own fiber tree in sync with the real DOM; forcibly
  // removeChild-ing a node React still believes exists desyncs that
  // internal bookkeeping. React attaches ONE delegated listener at the
  // root for every event type rather than per-element handlers, so once
  // that desync happens its event dispatch can silently stop finding a
  // target for anything, anywhere on the page -- which is exactly the
  // "nothing is clickable or typable anymore" breakage this caused before.
  // Hiding via inline styles (kept off with !important so the app's own
  // stylesheet can't win the cascade back) leaves the node in place and
  // React's tree untouched, while still fully removing it from view and
  // from the hit-test/tab order.
  try{
    el.style.setProperty('display','none','important');
    el.style.setProperty('pointer-events','none','important');
    el.setAttribute('aria-hidden','true');
    el.setAttribute('inert','');
  }catch(e){}
}
function removeExpiredSessionModal(){
  var bodyText=document.body&&document.body.innerText;
  var sawExpired=!!bodyText&&bodyText.toLowerCase().indexOf("session has expired")!==-1;
  if(sawExpired){
    // The real upstream markup for this dialog is a plain
    // <div id="modal-expired-session" data-testid="modal-expired-session">
    // -- not role="dialog"/"alertdialog" and not inside a data-radix-portal
    // wrapper, so neither of those (reasonable-looking, but wrong for this
    // specific dialog) signals ever matched it. That mismatch is why the
    // previous version only ever hid a small inner text node instead of the
    // actual full-viewport clickable container, leaving the real thing live
    // and still swallowing every click/keystroke on the page. Prefer this
    // exact, stable identifier; keep the generic role/portal walk-up only as
    // a fallback in case a future upstream build changes the markup.
    var known=document.getElementById('modal-expired-session')
      ||document.querySelector('[data-testid="modal-expired-session"]');
    if(known){
      hideEl(known);
      window.__mirrorExpiredModalSeen=Date.now();
    }else{
      var leaves=document.body.querySelectorAll('*'),target=null;
      for(var i=0;i<leaves.length;i++){
        var el=leaves[i];
        if(el.children.length===0&&el.textContent&&el.textContent.toLowerCase().indexOf("session has expired")!==-1){target=el;break;}
      }
      if(target){
        var n=target,dialog=null;
        for(var j=0;j<20&&n&&n!==document.body;j++){
          var role=n.getAttribute&&n.getAttribute('role');
          if(role==='dialog'||role==='alertdialog'||(n.hasAttribute&&n.hasAttribute('data-radix-portal'))){dialog=n;break;}
          n=n.parentElement;
        }
        if(!dialog)dialog=target;
        var portalRoot=dialog.closest?dialog.closest('[data-radix-portal]')||dialog:dialog;
        hideEl(portalRoot);
        window.__mirrorExpiredModalSeen=Date.now();
      }
    }
  }
  // Radix (and similar) dialog libraries render the dimmed backdrop as a
  // sibling overlay element, not inside the dialog itself, so it survives
  // hiding the dialog above and keeps swallowing clicks even once the
  // dialog is gone -- neutralize it by selector, and (for a few seconds
  // after we last saw the expired-session text, in case the backdrop
  // doesn't match any of these selectors) any large invisible fixed-position
  // element still capturing pointer events anywhere on the page.
  var recentlyExpired=!!window.__mirrorExpiredModalSeen&&(Date.now()-window.__mirrorExpiredModalSeen)<5000;
  if(sawExpired||recentlyExpired){
    var overlaySelector='[data-radix-dialog-overlay],[class*="overlay" i][class*="fixed" i],[data-state="open"][class*="backdrop" i]';
    var overlays=document.querySelectorAll(overlaySelector);
    for(var k=0;k<overlays.length;k++)hideEl(overlays[k]);
    var candidates=document.body.querySelectorAll('div,section');
    for(var m=0;m<candidates.length;m++){
      var c=candidates[m];
      if(c.id==='mirror-launcher'||c.closest('#mirror-launcher'))continue;
      var cs=getComputedStyle(c);
      if(cs.position!=='fixed'||cs.pointerEvents==='none')continue;
      var r=c.getBoundingClientRect();
      if(r.width>=window.innerWidth*0.9&&r.height>=window.innerHeight*0.9)hideEl(c);
    }
  }
  document.documentElement.style.removeProperty('pointer-events');
  document.body.style.removeProperty('pointer-events');
  document.body.style.removeProperty('overflow');
  document.documentElement.removeAttribute('data-scroll-locked');
  document.body.removeAttribute('data-scroll-locked');
  // The real bug: accessible dialog implementations (Radix included) don't
  // just render a backdrop -- opening one also marks every OTHER top-level
  // sibling of the dialog as aria-hidden/inert, so screen readers and
  // keyboard/tab navigation skip straight to the modal (a focus trap).
  // That marking is applied directly to the rest of the app's content, not
  // to the dialog itself, so hiding/removing the dialog above does nothing
  // to undo it -- the page looks normal again but every element is still
  // marked inert underneath, which is why nothing was clickable or
  // typable even after the dialog visually disappeared. Only runs while
  // we've actually just handled an expired-session dialog, since aria-hidden
  // is also used legitimately elsewhere (e.g. a real, dismissable modal that
  // IS currently open) and we must not rip focus-trapping out from under
  // one of those.
  if(sawExpired||recentlyExpired){
    var inertEls=document.body.querySelectorAll('[inert],[aria-hidden="true"]');
    for(var p=0;p<inertEls.length;p++){
      var ie=inertEls[p];
      if(ie.id==='mirror-launcher'||ie.closest('#mirror-launcher'))continue;
      if(ie.style.display==='none')continue; // one of the dialog/overlay nodes we just hid
      ie.removeAttribute('inert');
      ie.removeAttribute('aria-hidden');
    }
  }
  return sawExpired;
}
setInterval(removeExpiredSessionModal,500);
removeExpiredSessionModal();

var sidebarOpenedOnce=false;
function ensureSidebarOpenOnce(){
  if(sidebarOpenedOnce)return;
  var btn=document.querySelector('[data-testid="open-sidebar-button"]');
  if(!btn)return;
  sidebarOpenedOnce=true;
  if(btn.getAttribute('aria-expanded')==='false')btn.click();
}
ensureSidebarOpenOnce();
var sidebarPoll=setInterval(function(){
  ensureSidebarOpenOnce();
  if(sidebarOpenedOnce)clearInterval(sidebarPoll);
},200);
setTimeout(function(){clearInterval(sidebarPoll);},10000);
})();`;
