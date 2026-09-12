import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import test from "node:test";

// POST /api/chat unconditionally calls `reply.raw.socket?.setNoDelay(true)`
// once it hijacks the reply - true under a real HTTP server, but
// app.inject()'s simulated response object backs `.raw.socket` with a plain
// node:stream Writable that has no such method, so calling it throws. This
// adds a harmless no-op stub for the duration of these tests only (never
// overwriting a real implementation, and only meaningful under inject()
// anyway - a real net.Socket already has its own setNoDelay).
if (typeof Writable.prototype.setNoDelay !== "function") {
  Writable.prototype.setNoDelay = function setNoDelay() {};
}

// index.ts's buildApp() wires up the whole Fastify app around the SAME
// store.js/auth.js/egress.js module instances this file imports (all plain,
// query-less specifiers - the established convention for sharing state with
// code under test; see auth.test.mjs/chat-service.test.mjs). One app
// instance is reused across this whole file; per-test isolation comes from
// unique accountIds/sessions, not fresh directories or fresh app instances.
const dir = mkdtempSync(path.join(tmpdir(), "mirror-routes-"));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = "test-control-key";
const store = await import("../dist/store.js");
const egress = await import("../dist/egress.js");
const { buildApp } = await import("../dist/index.js");
const app = await buildApp();
test.describe("server / routes", () => {
test.after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const AUTH = { host: "localhost", authorization: "Bearer test-control-key" };

function jwtWithExp(secondsFromNow) {
  const payloadB64 = Buffer.from(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow }),
  ).toString("base64url");
  return `header.${payloadB64}.signature`;
}

function useSession(accountId) {
  store.saveVerifiedSession(`session-token-${accountId}`, accountId, `device-${accountId}`);
  store.updateMintedToken(`cached-access-${accountId}`, Date.now() + 60 * 60 * 1000, null);
}

function fetchRouter(routes) {
  return async (url, init = {}) => {
    const u = new URL(String(url));
    for (const [matcher, handler] of routes) {
      if (typeof matcher === "string" ? u.pathname === matcher : matcher.test(u.pathname)) {
        return handler(u, init);
      }
    }
    throw new Error(`unexpected fetch to ${u.href}`);
  };
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function meRoute(accountId) {
  return [/\/backend-api\/me$/, () => Response.json({ account: { account_user_id: accountId } })];
}

// --- onRequest hook: host/origin/bootstrap/auth gating ----------------------

test("an untrusted Host header is rejected with 421 before anything else runs", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/api/health",
    headers: { host: "evil.example.com" },
  });
  assert.equal(res.statusCode, 421);
});

test("a mutating cross-origin request is rejected with 403 and a specific message", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers: { ...AUTH, origin: "http://evil.example.com" },
    payload: {},
  });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "Cross-origin control request rejected");
});

test("/api/health and /mirror/assets/ bypass the local-authorization check entirely", async () => {
  const res = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost" } });
  assert.notEqual(res.statusCode, 401);
});

test("mayBootstrapBrowser requests get a fresh control cookie set", async () => {
  const res = await app.inject({
    method: "GET",
    url: "/",
    headers: { host: "localhost", accept: "text/html,application/xhtml+xml" },
  });
  const setCookie = res.headers["set-cookie"];
  assert.ok(setCookie, "a bootstrap request must receive a mirror_control cookie");
  assert.match(String(setCookie), /^mirror_control=/);
});

test("an unauthorized request to a protected route is rejected with 401", async () => {
  const res = await app.inject({ method: "GET", url: "/api/models", headers: { host: "localhost" } });
  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(res.body).error.message, /Open Mirror in your browser/);
});

// --- setErrorHandler ---------------------------------------------------------

test("a ZodError from body validation becomes a 400 with the schema's custom message", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/session",
    headers: AUTH,
    payload: { sessionToken: "too-short" },
  });
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /doesn't look like a valid session token/);
});

test("an unexpected non-statusCode error is hidden behind a generic 500 message", () =>
  withFetch(
    async () => {
      throw new TypeError("some deep network internals broke");
    },
    async () => {
      useSession("acct-500");
      const res = await app.inject({ method: "GET", url: "/api/models", headers: AUTH });
      assert.equal(res.statusCode, 500);
      assert.deepEqual(JSON.parse(res.body), { error: "Internal server error" });
    },
  ));

// --- GET /api/health ----------------------------------------------------------

test("GET /api/health reports storage, configuration, and egress status", async () => {
  const before = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost" } });
  const beforeBody = JSON.parse(before.body);
  assert.equal(beforeBody.storage, "sqlite");
  assert.equal(beforeBody.egress.mode, "direct");

  await withFetch(
    async () => new Response("warp=on\nloc=YY\n", { status: 200 }),
    () => egress.verifyRequiredEgress(),
  );
  useSession("acct-health");
  const after = await app.inject({ method: "GET", url: "/api/health", headers: { host: "localhost" } });
  const afterBody = JSON.parse(after.body);
  assert.equal(afterBody.configured, true);
  assert.equal(afterBody.ok, true, "healthy db + configured session + verified egress -> ok");
});

// --- /api/session --------------------------------------------------------------

test("POST /api/session verifies, persists, and claims default-account data", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => Response.json({ account: { account_user_id: "new-acct" }, email: "user@example.com" })],
    ]),
    async () => {
      store.createConversation({ model: "auto", accountId: "default" });
      const res = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: AUTH,
        payload: { sessionToken: "a-long-enough-session-token-value" },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.accountId, "new-acct");
      assert.equal(body.email, "user@example.com");
      assert.equal(store.getSession().accountId, "new-acct");
      assert.ok(store.listConversations("new-acct").length >= 1, "pre-account-key data must be claimed");
    },
  ));

test("POST /api/session rejects with 409 if the session changes mid-verification", () =>
  withFetch(
    fetchRouter([
      [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
      [/\/backend-api\/me$/, () => {
        // Simulate a *second, concurrent* POST /api/session completing while
        // this one's own verification is still in flight.
        store.saveVerifiedSession("a-different-racing-session-token", "racer");
        return Response.json({ account: { account_user_id: "should-not-be-used" } });
      }],
    ]),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/session",
        headers: AUTH,
        payload: { sessionToken: "a-long-enough-session-token-value-2" },
      });
      assert.equal(res.statusCode, 409);
      assert.equal(store.getSession().accountId, "racer", "the racing session must win, not the stale one");
    },
  ));

test("GET/DELETE /api/session reflect and clear the stored session", async () => {
  useSession("acct-session-crud");
  const got = await app.inject({ method: "GET", url: "/api/session", headers: AUTH });
  assert.equal(JSON.parse(got.body).configured, true);

  const del = await app.inject({ method: "DELETE", url: "/api/session", headers: AUTH });
  assert.deepEqual(JSON.parse(del.body), { ok: true });

  const after = await app.inject({ method: "GET", url: "/api/session", headers: AUTH });
  assert.deepEqual(JSON.parse(after.body), { configured: false, savedAt: null, hasTurnstileToken: false });
});

// --- /api/models, /api/gpts ---------------------------------------------------

test("GET /api/models strips the raw field from normalized models", () =>
  withFetch(
    fetchRouter([
      [/\/backend-api\/models$/, () =>
        Response.json({ models: [{ slug: "gpt-5", title: "GPT-5" }] })],
    ]),
    async () => {
      useSession("acct-models");
      const res = await app.inject({ method: "GET", url: "/api/models", headers: AUTH });
      assert.equal(res.statusCode, 200, res.body);
      const models = JSON.parse(res.body);
      assert.ok(models.length >= 1);
      assert.ok(!("raw" in models[0]));
    },
  ));

test("GET /api/gpts merges gizmo sidebar + bootstrap, de-duplicates by id, and tolerates one endpoint failing", () =>
  withFetch(
    fetchRouter([
      [/\/backend-api\/gizmos\/snorlax\/sidebar/, () => new Response("nope", { status: 500 })],
      [/\/backend-api\/gizmos\/bootstrap/, () =>
        Response.json({ items: [{ id: "g-1", display: { name: "Helper" } }] })],
    ]),
    async () => {
      useSession("acct-gpts");
      const res = await app.inject({ method: "GET", url: "/api/gpts", headers: AUTH });
      assert.equal(res.statusCode, 200, res.body);
      const gizmos = JSON.parse(res.body);
      assert.equal(gizmos.length, 1);
      assert.equal(gizmos[0].id, "g-1");
      assert.ok(!("raw" in gizmos[0]));
    },
  ));

// --- /api/conversations (list/sync + create) ----------------------------------

test("GET /api/conversations without sync reads straight from the local mirror", async () => {
  useSession("acct-list-nosync");
  store.createConversation({ model: "auto", accountId: "acct-list-nosync", title: "Local one" });
  const res = await app.inject({
    method: "GET",
    url: "/api/conversations?sync=false&resync=false",
    headers: AUTH,
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.items.length, 1);
  assert.equal(body.total, 1);
});

test("GET /api/conversations with sync=true pulls a page from upstream first", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-list-sync"),
      [/\/backend-api\/conversations/, () =>
        Response.json({
          items: [{ id: "up-1", title: "Remote", create_time: "t", update_time: "t", current_node: "n1" }],
          total: 1,
        })],
    ]),
    async () => {
      useSession("acct-list-sync");
      const res = await app.inject({
        method: "GET",
        url: "/api/conversations?sync=true&limit=10&offset=0",
        headers: AUTH,
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].conversationId, "up-1");
    },
  ));

test("GET /api/conversations rejects an unparsable query with 400", async () => {
  const res = await app.inject({ method: "GET", url: "/api/conversations?sync=garbage", headers: AUTH });
  assert.equal(res.statusCode, 400);
});

test("POST /api/conversations creates a conversation for the current account, defaulting the model", async () => {
  useSession("acct-create");
  const res = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers: AUTH,
    payload: {},
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.model, "auto");
  assert.equal(body.accountId, "acct-create");
});

// --- /api/conversations/:id ----------------------------------------------------

test("GET /api/conversations/:id 404s for an unknown id or one owned by a different account", async () => {
  useSession("acct-owner-a");
  const owned = store.createConversation({ model: "auto", accountId: "acct-owner-a" });
  useSession("acct-owner-b");
  const res = await app.inject({ method: "GET", url: `/api/conversations/${owned.id}`, headers: AUTH });
  assert.equal(res.statusCode, 404);
  const res2 = await app.inject({ method: "GET", url: "/api/conversations/no-such-id", headers: AUTH });
  assert.equal(res2.statusCode, 404);
});

test("GET /api/conversations/:id lazily hydrates messages from upstream on first view", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-hydrate"),
      [/\/backend-api\/conversation\/up-hydrate$/, () =>
        Response.json({
          current_node: "n2",
          mapping: {
            n1: { parent: null, message: { id: "m1", author: { role: "user" }, content: { content_type: "text", parts: ["hi"] }, status: "finished_successfully" } },
            n2: { parent: "n1", message: { id: "m2", author: { role: "assistant" }, content: { content_type: "text", parts: ["hello"] }, status: "finished_successfully" } },
          },
        })],
    ]),
    async () => {
      useSession("acct-hydrate");
      const conversation = store.createConversation({ model: "auto", accountId: "acct-hydrate" });
      store.updateConversation({ ...conversation, conversationId: "up-hydrate" });
      const res = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}`, headers: AUTH });
      assert.equal(res.statusCode, 200, res.body);
      const body = JSON.parse(res.body);
      assert.equal(body.messages.length, 2);

      // A second view must not re-hydrate (messages already exist locally).
      const res2 = await app.inject({ method: "GET", url: `/api/conversations/${conversation.id}`, headers: AUTH });
      assert.equal(JSON.parse(res2.body).messages.length, 2);
    },
  ));

test("PATCH /api/conversations/:id updates the model, 404s for a foreign conversation", async () => {
  useSession("acct-patch");
  const conversation = store.createConversation({ model: "auto", accountId: "acct-patch" });
  const res = await app.inject({
    method: "PATCH",
    url: `/api/conversations/${conversation.id}`,
    headers: AUTH,
    payload: { model: "gpt-5-thinking" },
  });
  assert.equal(JSON.parse(res.body).model, "gpt-5-thinking");
  const res404 = await app.inject({
    method: "PATCH",
    url: "/api/conversations/no-such-id",
    headers: AUTH,
    payload: { model: "auto" },
  });
  assert.equal(res404.statusCode, 404);
});

test("DELETE /api/conversations/:id reports ok:false (not 404) for a foreign conversation, ok:true when it deletes", async () => {
  useSession("acct-delete-owner");
  const conversation = store.createConversation({ model: "auto", accountId: "acct-delete-owner" });
  useSession("acct-delete-other");
  const denied = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}`, headers: AUTH });
  assert.deepEqual(JSON.parse(denied.body), { ok: false });

  useSession("acct-delete-owner");
  const ok = await app.inject({ method: "DELETE", url: `/api/conversations/${conversation.id}`, headers: AUTH });
  assert.deepEqual(JSON.parse(ok.body), { ok: true });
  assert.equal(store.getConversation(conversation.id), null);
});

test("POST /api/conversations/:id/stop 404s for a foreign conversation and reports whether anything was actually stopped", async () => {
  useSession("acct-stop-owner");
  const conversation = store.createConversation({ model: "auto", accountId: "acct-stop-owner" });
  const res = await app.inject({ method: "POST", url: `/api/conversations/${conversation.id}/stop`, headers: AUTH });
  assert.deepEqual(JSON.parse(res.body), { ok: false });

  const res404 = await app.inject({ method: "POST", url: "/api/conversations/no-such-id/stop", headers: AUTH });
  assert.equal(res404.statusCode, 404);
});

test("POST /api/conversations/:id/branch rejects a non-branchable message and succeeds for an eligible one", async () => {
  useSession("acct-branch");
  const conversation = store.createConversation({ model: "auto", accountId: "acct-branch" });
  const msgNoUpstream = store.addMessage({
    conversationId: conversation.id, upstreamNodeId: null, role: "user", content: "no upstream node", status: "done", events: [],
  });
  const badBranch = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversation.id}/branch`,
    headers: AUTH,
    payload: { messageId: msgNoUpstream.id },
  });
  assert.equal(badBranch.statusCode, 400);

  const msgWithUpstream = store.addMessage({
    conversationId: conversation.id, upstreamNodeId: "upstream-node-1", role: "assistant", content: "ok", status: "done", events: [],
  });
  const goodBranch = await app.inject({
    method: "POST",
    url: `/api/conversations/${conversation.id}/branch`,
    headers: AUTH,
    payload: { messageId: msgWithUpstream.id, title: "My branch" },
  });
  assert.equal(goodBranch.statusCode, 200, goodBranch.body);
  assert.equal(JSON.parse(goodBranch.body).isBranch, true);

  const res404 = await app.inject({
    method: "POST",
    url: "/api/conversations/no-such-id/branch",
    headers: AUTH,
    payload: { messageId: randomUUID() },
  });
  assert.equal(res404.statusCode, 404);
});

// --- /api/files -----------------------------------------------------------------

function multipartBody(fieldName, filename, contentType, content) {
  const boundary = "----mirrorTestBoundary";
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { boundary, body };
}

test("POST /api/files requires a file and otherwise uploads it through the backend client", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-files"),
      [/\/backend-api\/files$/, () => Response.json({ upload_url: "https://blob.example/put", file_id: "file-abc" })],
      [/^\/put$/, () => new Response(null, { status: 200 })], // fetchRouter matches on pathname, not full href
      [/\/backend-api\/files\/file-abc\/uploaded$/, () => Response.json({ marked: true })],
    ]),
    async () => {
      useSession("acct-files");
      // A non-multipart body never reaches the "no file" business-logic
      // branch at all - @fastify/multipart's req.file() throws its own
      // FST_INVALID_MULTIPART_CONTENT_TYPE error first (a real, separate
      // negative path, mapped by the generic error handler to its own
      // statusCode - 406 here - rather than the route's own 400).
      const wrongContentType = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: { ...AUTH, "content-type": "application/json" },
        payload: {},
      });
      assert.equal(wrongContentType.statusCode, 406);

      // A genuinely multipart request with zero parts *does* reach "No file
      // uploaded" (part is undefined, not thrown).
      const emptyBoundary = "----mirrorEmptyBoundary";
      const noFile = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${emptyBoundary}` },
        payload: `--${emptyBoundary}--\r\n`,
      });
      assert.equal(noFile.statusCode, 400);
      assert.match(JSON.parse(noFile.body).error, /No file uploaded/);

      const { boundary, body } = multipartBody("file", "pic.png", "image/png", "pretend-image-bytes");
      const res = await app.inject({
        method: "POST",
        url: "/api/files",
        headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      assert.equal(res.statusCode, 200, res.body);
      const file = JSON.parse(res.body);
      assert.equal(file.fileId, "file-abc");
      assert.equal(store.ownsFile("file-abc", "acct-files"), true);
    },
  ));

// --- /api/assets ------------------------------------------------------------------

test("GET /api/assets validates pointer scheme, ownership, and redirects to the resolved download URL", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-assets"),
      [/\/backend-api\/files\/f1\/download$/, () => Response.json({ download_url: "https://blob.example/f1" })],
      // resolveAssetDownload extracts the id from the '#'-separated sediment
      // pointer by finding the segment that itself starts with "file-"/"file_"
      // (falling back to the whole pointer) - "sediment://file-f2#x" below
      // yields id "file-f2", not "f2".
      [/\/backend-api\/files\/download\/file-f2$/, () => Response.json({ download_url: "https://blob.example/f2" })],
    ]),
    async () => {
      useSession("acct-assets");

      const badScheme = await app.inject({
        method: "GET", url: "/api/assets?pointer=" + encodeURIComponent("http://evil/thing"), headers: AUTH,
      });
      assert.equal(badScheme.statusCode, 400);

      const notOwned = await app.inject({
        method: "GET", url: "/api/assets?pointer=" + encodeURIComponent("file-service://f1"), headers: AUTH,
      });
      assert.equal(notOwned.statusCode, 404);

      store.saveFile({ fileId: "f1", useCase: "multimodal", fileName: "a", mimeType: "image/png" }, "acct-assets");
      const owned = await app.inject({
        method: "GET", url: "/api/assets?pointer=" + encodeURIComponent("file-service://f1"), headers: AUTH,
      });
      assert.equal(owned.statusCode, 302);
      assert.equal(owned.headers.location, "https://blob.example/f1");

      const sedimentNoConvo = await app.inject({
        method: "GET", url: "/api/assets?pointer=" + encodeURIComponent("sediment://file-f2#x"), headers: AUTH,
      });
      assert.equal(sedimentNoConvo.statusCode, 404);

      const conversation = store.createConversation({ model: "auto", accountId: "acct-assets" });
      store.updateConversation({ ...conversation, conversationId: "up-assets" });
      const sedimentOwned = await app.inject({
        method: "GET",
        url:
          "/api/assets?pointer=" + encodeURIComponent("sediment://file-f2#x") +
          "&upstreamConversationId=up-assets",
        headers: AUTH,
      });
      assert.equal(sedimentOwned.statusCode, 302);
      assert.equal(sedimentOwned.headers.location, "https://blob.example/f2");
    },
  ));

// --- /api/chat (SSE) ---------------------------------------------------------------

function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${p}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("POST /api/chat rejects attachments that don't belong to the caller", async () => {
  useSession("acct-chat-attach");
  const res = await app.inject({
    method: "POST",
    url: "/api/chat",
    headers: AUTH,
    payload: {
      prompt: "hi",
      attachments: [{ fileId: "not-mine", fileName: "a", fileSize: 1, mimeType: "image/png", useCase: "multimodal" }],
    },
  });
  assert.equal(res.statusCode, 404);
});

test("POST /api/chat streams SSE delta/event/done frames on success", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-chat-ok"),
      [/\/backend-api\/conversation\/init$/, () => Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] })],
      [/\/backend-api\/gizmos\//, () => new Response("not found", { status: 404 })],
      [/\/backend-api\/sentinel\/chat-requirements\/prepare$/, () => Response.json({ prepare_token: "p", proofofwork: { required: false } })],
      [/\/backend-api\/sentinel\/chat-requirements\/finalize$/, () => Response.json({ token: "final" })],
      [/\/backend-api\/f\/conversation$/, () =>
        sseBody([
          JSON.stringify({
            p: "", o: "add",
            v: { conversation_id: "upstream-ok", message: { id: "assistant-ok", author: { role: "assistant" }, content: { content_type: "text", parts: ["done reply"] }, status: "finished_successfully" } },
          }),
          "[DONE]",
        ])],
    ]),
    async () => {
      useSession("acct-chat-ok");
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { ...AUTH, "x-turnstile-token": "native-one-shot" },
        payload: { prompt: "hello there", model: "auto" },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      assert.match(res.body, /event: delta/);
      assert.match(res.body, /event: done/);
      assert.match(res.body, /"text":"done reply"/);
    },
  ));

test("POST /api/chat forwards non-filtered upstream events (e.g. tool/marker frames) as SSE \"event\" frames", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-chat-events"),
      [/\/backend-api\/conversation\/init$/, () => Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] })],
      [/\/backend-api\/gizmos\//, () => new Response("not found", { status: 404 })],
      [/\/backend-api\/sentinel\/chat-requirements\/prepare$/, () => Response.json({ prepare_token: "p", proofofwork: { required: false } })],
      [/\/backend-api\/sentinel\/chat-requirements\/finalize$/, () => Response.json({ token: "final" })],
      [/\/backend-api\/f\/conversation$/, () =>
        sseBody([
          // A "typed" upstream frame (a bare `type` field, not the usual
          // {p,o,v} patch shape) that isn't one of publicEvent()'s filtered
          // kinds (raw/assistant_text/message) - it normalizes to a "marker"
          // event and must be forwarded to the client as its own SSE frame.
          JSON.stringify({
            type: "message_marker",
            message_id: "assistant-events",
            marker: "last_token",
            event: "last",
          }),
          JSON.stringify({
            p: "", o: "add",
            v: { conversation_id: "upstream-events", message: { id: "assistant-events", author: { role: "assistant" }, content: { content_type: "text", parts: ["done reply"] }, status: "finished_successfully" } },
          }),
          "[DONE]",
        ])],
    ]),
    async () => {
      useSession("acct-chat-events");
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: { ...AUTH, "openai-sentinel-turnstile-token": "native-one-shot" },
        payload: { prompt: "hello there", model: "auto" },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(res.body, /event: event/);
      assert.match(res.body, /"kind":"marker"/);
      assert.ok(!res.body.includes('"raw"'), "publicEvent must strip the raw field before forwarding");
    },
  ));

test("POST /api/chat reports a friendly message when the turn is aborted, and the real error otherwise", () =>
  withFetch(
    fetchRouter([
      meRoute("acct-chat-fail"),
      [/\/backend-api\/conversation\/init$/, () => new Response("upstream is down", { status: 503 })],
    ]),
    async () => {
      useSession("acct-chat-fail");
      const res = await app.inject({
        method: "POST",
        url: "/api/chat",
        headers: AUTH,
        payload: { prompt: "hi", model: "auto" },
      });
      assert.equal(res.statusCode, 200); // the stream itself always opens 200; failure rides inside an SSE "error" frame
      assert.match(res.body, /event: error/);
      assert.ok(!res.body.includes("Generation stopped"));
    },
  ));

// --- /mirror/openapi, static assets, notFoundHandler --------------------------

test("GET /mirror/openapi serves the generated document as json or yaml", async () => {
  const json = await app.inject({ method: "GET", url: "/mirror/openapi", headers: AUTH });
  assert.equal(json.statusCode, 200);
  assert.match(json.headers["content-type"], /json/);
  const parsed = JSON.parse(json.body);
  assert.ok(parsed.paths);

  const yamlRes = await app.inject({ method: "GET", url: "/mirror/openapi?format=yaml", headers: AUTH });
  assert.equal(yamlRes.statusCode, 200);
  assert.match(yamlRes.headers["content-type"], /yaml/);
});

test("static Mirror assets: playground shell, injected CSS, and injected JS all serve with the right content-type", async () => {
  const playground = await app.inject({ method: "GET", url: "/mirror/playground", headers: AUTH });
  assert.equal(playground.statusCode, 200);

  const css = await app.inject({ method: "GET", url: "/mirror/inject.css", headers: AUTH });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers["content-type"], /text\/css/);

  const js = await app.inject({ method: "GET", url: "/mirror/inject.js", headers: AUTH });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"], /javascript/);
});

test("the not-found handler 404s unmatched /v1/ paths and proxies everything else upstream", () =>
  withFetch(
    async () => new Response("upstream fallback body", { headers: { "content-type": "text/plain" } }),
    async () => {
      const v1 = await app.inject({ method: "GET", url: "/v1/no-such-route", headers: AUTH });
      assert.equal(v1.statusCode, 404);
      // The global onSend hook (index.ts) normalizes every /v1/ failure -
      // including the plain-string 404 the notFoundHandler sends - into
      // the same structured, safe envelope api-errors.ts's apiError()
      // produces elsewhere (see openai-routes.test.mjs's error tests).
      const v1Body = JSON.parse(v1.body);
      assert.equal(v1Body.error.code, "not_found");
      assert.equal(v1Body.error.type, "invalid_request_error");
      assert.equal(v1Body.error.message, "The requested resource was not found.");
      assert.equal(v1Body.error.request_id, v1.headers["x-request-id"]);

      const other = await app.inject({ method: "GET", url: "/some/unrecognized/path", headers: AUTH });
      assert.equal(other.statusCode, 200);
      assert.equal(other.body, "upstream fallback body");
    },
  ));

test("session verification accepts a profile with no account id or email", async () => {
  await withFetch(fetchRouter([
    [/\/api\/auth\/session$/, () => Response.json({ accessToken: jwtWithExp(3600) })],
    [/\/backend-api\/me$/, () => Response.json({})],
  ]), async () => {
    const res = await app.inject({ method: "POST", url: "/api/session", headers: AUTH, payload: { sessionToken: "synthetic-session-token-long-enough" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().accountId, null);
    assert.equal(res.json().email, null);
  });
});

test("GPT listing deduplicates entries shared by bootstrap and sidebar", async () => {
  useSession("gpt-duplicates");
  await withFetch(async () => Response.json({ items: [{ id: "g-same", display_name: "Same", short_url: "same" }] }), async () => {
    const res = await app.inject({ method: "GET", url: "/api/gpts", headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().length, 1);
    assert.equal(res.json()[0].id, "g-same");
  });
});

for (const [error, expected] of [[new DOMException("aborted", "AbortError"), "Generation stopped"], ["plain failure", "plain failure"]]) {
  test(`chat stream exposes a useful error for ${expected}`, async () => {
    useSession(`error-${expected}`);
    await withFetch(async () => { throw error; }, async () => {
      const res = await app.inject({ method: "POST", url: "/api/chat", headers: AUTH, payload: { prompt: "hi", model: "auto" } });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, new RegExp(expected));
    });
  });
}

test("error handler gives a safe fallback for a non-Error exception", async () => {
  const probe = await buildApp();
  try {
    probe.get("/api/test-error", async () => { throw { statusCode: 422 }; });
    const res = await probe.inject({ method: "GET", url: "/api/test-error", headers: AUTH });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(res.json(), { error: "Request failed" });
    // Diagnostic request objects may not yet have a URL; logging must still work.
    assert.doesNotThrow(() => probe.log.info({ req: { method: "GET" } }, "incomplete request diagnostic"));
  } finally { await probe.close(); }
});

test("disconnecting a local streaming HTTP client aborts upstream work", { timeout: 5000 }, async () => {
  const { request } = await import("node:http");
  const probe = await buildApp();
  useSession("disconnect-test");
  let started;
  const upstreamStarted = new Promise(resolve => { started = resolve; });
  let observedAbort;
  const upstreamAborted = new Promise(resolve => { observedAbort = resolve; });
  try {
    const address = await probe.listen({ port: 0, host: "127.0.0.1" });
    await withFetch(async (_url, init) => {
      started();
      return new Promise((_resolve, reject) => {
        const abort = () => { observedAbort(); reject(new DOMException("disconnected", "AbortError")); };
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      });
    }, async () => {
      const req = request(`${address}/api/chat`, { method: "POST", headers: { ...AUTH, "content-type": "application/json" } });
      req.on("error", () => {});
      req.end(JSON.stringify({ prompt: "disconnect fixture", model: "auto" }));
      await upstreamStarted;
      const closed = new Promise(resolve => req.once("close", resolve));
      req.destroy();
      await closed;
      await upstreamAborted;
    });
  } finally { await probe.close(); }
});


test("blank CORS configuration allows CLI requests and retains origin checks", async () => {
  const original = process.env.MIRROR_WEB_ORIGIN;
  try {
    for (const value of ["", "   "]) {
      process.env.MIRROR_WEB_ORIGIN = value;
      const configuredApp = await buildApp();
      try {
        const health = await configuredApp.inject({ url: "/api/health", headers: { host: "localhost" } });
        assert.equal(health.statusCode, 200);
        const completion = await configuredApp.inject({
          method: "POST", url: "/v1/chat/completions", headers: AUTH, payload: { messages: [] },
        });
        assert.equal(completion.statusCode, 400, "CLI request must reach body validation");
        const rejected = await configuredApp.inject({
          method: "POST", url: "/v1/chat/completions",
          headers: { ...AUTH, origin: "https://evil.example" }, payload: { messages: [] },
        });
        assert.equal(rejected.statusCode, 400);
      } finally {
        await configuredApp.close();
      }
    }
  } finally {
    if (original === undefined) delete process.env.MIRROR_WEB_ORIGIN;
    else process.env.MIRROR_WEB_ORIGIN = original;
  }
});


test("extension API CORS permits bearer clients but not ambient cookie authentication", async () => {
  const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const headers = { ...AUTH, origin };
  const preflight = await app.inject({ method: "OPTIONS", url: "/v1/chat/completions", headers: {
    host: "localhost", origin, "access-control-request-method": "POST",
    "access-control-request-headers": "authorization,content-type",
  } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  assert.match(preflight.headers["access-control-allow-headers"], /Authorization/i);
  for (const site of [origin, "https://client.example"]) {
    const accepted = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...headers, origin: site }, payload: { messages: [] } });
    assert.equal(accepted.statusCode, 400);
    assert.equal(accepted.headers["access-control-allow-origin"], site);
    assert.equal(accepted.headers["access-control-allow-credentials"], undefined);
  }
  const bootstrap = await app.inject({ url: "/", headers: { host: "localhost", accept: "text/html" } });
  for (const extra of [{}, { authorization: "Bearer wrong" }, { cookie: bootstrap.headers["set-cookie"] }]) {
    const denied = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { host: "localhost", origin, ...extra }, payload: { messages: [] } });
    assert.equal(denied.statusCode, 401);
  }
  const control = await app.inject({ method: "POST", url: "/api/conversations", headers, payload: {} });
  assert.equal(control.statusCode, 403);
  const badHost = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...headers, host: "evil.example" }, payload: { messages: [] } });
  assert.equal(badHost.statusCode, 421);
  assert.equal(badHost.headers["access-control-allow-origin"], undefined);
  store.clearSession();
  const streamed = await app.inject({ method: "POST", url: "/v1/chat/completions", headers,
    payload: { model: "auto", messages: [{ role: "user", content: "test" }], stream: true } });
  assert.equal(streamed.statusCode, 200);
  assert.equal(streamed.headers["access-control-allow-origin"], origin);
  assert.match(streamed.body, /data:.*error/);
});


test("cross-origin API authenticates with only OPENAI_API_KEY configured", async () => {
  const names = ["MIRROR_API_KEY", "MIRROR_API_KEYS", "OPENAI_API_KEY"];
  const original = names.map(name => process.env[name]);
  let configuredApp;
  try {
    process.env.MIRROR_API_KEY = "";
    process.env.MIRROR_API_KEYS = "";
    process.env.OPENAI_API_KEY = "compat-test-key";
    configuredApp = await buildApp();
    for (const [key, expected] of [["compat-test-key", 400], ["wrong-key", 401]]) {
      const response = await configuredApp.inject({ method: "POST", url: "/v1/chat/completions",
        headers: { host: "localhost", origin: "https://client.example", authorization: `Bearer ${key}` },
        payload: { messages: [] } });
      assert.equal(response.statusCode, expected);
      assert.equal(response.headers["access-control-allow-origin"], "https://client.example");
    }
  } finally {
    await configuredApp?.close();
    names.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
});

test("new Custom GPT native chat hides file-search events but forwards Python events", () =>
  withFetch(fetchRouter([
    meRoute("acct-chat-visibility"),
    [/\/backend-api\/conversation\/init$/, () => Response.json({ default_model_slug: "model-a" })],
    [/\/backend-api\/gizmos\//, () => new Response("not found", { status: 404 })],
    [/\/backend-api\/sentinel\/chat-requirements\/prepare$/, () => Response.json({ prepare_token: "p", proofofwork: { required: false } })],
    [/\/backend-api\/sentinel\/chat-requirements\/finalize$/, () => Response.json({ token: "final" })],
    [/\/backend-api\/f\/conversation$/, () => sseBody([
      JSON.stringify({ type: "tool_status", tool_name: "file_search.msearch", text: "hidden search" }),
      JSON.stringify({ type: "tool_status", tool_name: "python", status: "finished_successfully" }),
      JSON.stringify({ p: "", o: "add", v: { conversation_id: "up-visibility", message: { id: "final", author: { role: "assistant" }, content: { content_type: "text", parts: ["Normal answer"] }, status: "finished_successfully" } } }),
      "[DONE]",
    ])],
  ]), async () => {
    useSession("acct-chat-visibility");
    const res = await app.inject({ method: "POST", url: "/api/chat", headers: AUTH, payload: { prompt: "hello", gizmoId: "g-custom" } });
    assert.equal(res.statusCode, 200);
    assert.doesNotMatch(res.body, /file_search|hidden search/);
    assert.match(res.body, /"name":"python"/);
    assert.match(res.body, /"text":"Normal answer"/);
  }));
});
