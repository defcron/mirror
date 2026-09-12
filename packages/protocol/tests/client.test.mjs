import assert from "node:assert/strict";
import test from "node:test";
import {
  ChatGptBackendClient,
  ChatGptConversationSession,
  BackendApiError,
  newDeviceId,
} from "../dist/index.js";

function fakeCreds() {
  return { accessToken: "access-token", deviceId: "device-1", cookie: "session-cookie" };
}

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// --- fetchMe ------------------------------------------------------------------------

test.describe("protocol / client", () => {
test("fetchMe captures accountId from account.account_user_id", () =>
  withFetch(
    async () => Response.json({ account: { account_user_id: "acc-1" } }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.fetchMe();
      assert.equal(client.accountId, "acc-1");
    },
  ));

test("fetchMe falls back to the first org id when there is no account", () =>
  withFetch(
    async () => Response.json({ orgs: { data: [{ id: "org-1" }] } }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.fetchMe();
      assert.equal(client.accountId, "org-1");
    },
  ));

test("fetchMe leaves accountId unset when neither account nor orgs identify one", () =>
  withFetch(
    async () => Response.json({}),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.fetchMe();
      assert.equal(client.accountId, null);
    },
  ));

// --- getJson / postJson error branches (via fetchModels etc) ------------------------

test("a GET call throws BackendApiError with the parsed body on a non-ok response", () =>
  withFetch(
    async () => new Response(JSON.stringify({ detail: "nope" }), { status: 403 }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.fetchModels(), (error) => {
        assert.ok(error instanceof BackendApiError);
        assert.equal(error.status, 403);
        assert.deepEqual(error.body, { detail: "nope" });
        return true;
      });
    },
  ));

test("a GET call throws BackendApiError with raw text when the error body isn't JSON", () =>
  withFetch(
    async () => new Response("plain text error", { status: 500 }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.fetchModels(), (error) => {
        assert.equal(error.body, "plain text error");
        return true;
      });
    },
  ));

test("a GET call throws BackendApiError when the ok response isn't a JSON object", () =>
  withFetch(
    async () => new Response("[1,2,3]", { status: 200 }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.fetchModels(), /non-object JSON/);
    },
  ));

test("fetchModels, fetchGptModels, fetchGizmoSidebar and fetchGizmoBootstrap hit the expected paths", async () => {
  const seen = [];
  await withFetch(
    async (url) => {
      seen.push(new URL(String(url)).pathname + new URL(String(url)).search);
      return Response.json({ ok: true });
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.fetchModels();
      await client.fetchGptModels();
      await client.fetchGizmoSidebar({ limit: 5, ownedOnly: true, conversationsPerGizmo: 2 });
      await client.fetchGizmoBootstrap({ limit: 999 });
      await client.fetchGizmo("gizmo one/two");
    },
  );
  assert.match(seen[0], /^\/backend-api\/models\?/);
  assert.equal(seen[1], "/backend-api/models/gpts");
  assert.match(seen[2], /^\/backend-api\/gizmos\/snorlax\/sidebar\?/);
  assert.ok(seen[2].includes("owned_only=true"));
  assert.match(seen[3], /^\/backend-api\/gizmos\/bootstrap\?limit=20$/); // capped at 20
  assert.equal(seen[4], "/backend-api/gizmos/gizmo%20one%2Ftwo");
});

// --- fetchConversations / fetchConversation -----------------------------------------

test("fetchConversations normalizes items, drops those without a string id, and derives total", () =>
  withFetch(
    async () =>
      Response.json({
        items: [
          { id: "c1", title: "First", create_time: "t1", is_archived: false, gizmo_id: "g1", current_node: "n1" },
          { id: 42 }, // no string id -> dropped
          { id: "c2" }, // missing optional fields -> defaults
          "not-an-object", // dropped by isObject filter
        ],
      }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.fetchConversations({ offset: 5, limit: 10, archived: true });
      assert.equal(result.total, 4); // raw.total not a number -> falls back to the raw items.length (pre-filter)
      assert.deepEqual(result.items.map((i) => i.id), ["c1", "c2"]);
      assert.equal(result.items[0].gizmoId, "g1");
      assert.equal(result.items[0].currentNodeId, "n1");
      assert.equal(result.items[1].title, "New chat");
      assert.equal(result.items[1].currentNodeId, null);
      assert.equal(result.items[1].gizmoId, null);
    },
  ));

test("fetchConversations reports raw.total when it is a real number", () =>
  withFetch(
    async () => Response.json({ items: [], total: 250 }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.fetchConversations();
      assert.equal(result.total, 250);
    },
  ));

test("fetchConversation fetches by id", () =>
  withFetch(
    async (url) => {
      assert.equal(new URL(String(url)).pathname, "/backend-api/conversation/abc");
      return Response.json({ ok: true });
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.fetchConversation("abc");
    },
  ));

// --- initConversation ----------------------------------------------------------------

test("initConversation defaults limits/blocked to empty arrays and filters non-string blocked entries", () =>
  withFetch(
    async () => Response.json({ default_model_slug: "gpt-4o", blocked_features: ["a", 1, "b"] }),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.initConversation({
        timezone: "UTC",
        timezoneOffsetMin: 0,
        gizmoId: "g-1",
        historyAndTrainingDisabled: true,
      });
      assert.equal(result.defaultModelSlug, "gpt-4o");
      assert.equal(result.intendedDefaultModelSlug, null);
      assert.deepEqual(result.limitsProgress, []);
      assert.deepEqual(result.blockedFeatures, ["a", "b"]);
    },
  ));

// --- uploadFile -----------------------------------------------------------------------

test("uploadFile uploads image bytes and marks the file uploaded", async () => {
  const calls = [];
  await withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      calls.push(u.pathname);
      if (u.pathname === "/backend-api/files")
        return Response.json({ upload_url: "https://blob.example/upload", file_id: "file-1" });
      if (u.href === "https://blob.example/upload") return new Response(null, { status: 200 });
      if (u.pathname === "/backend-api/files/file-1/uploaded") return Response.json({ marked: true });
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const file = await client.uploadFile({
        data: new Uint8Array([1, 2, 3]),
        fileName: "pic.png",
        mimeType: "image/png",
        width: 10,
        height: 20,
      });
      assert.equal(file.useCase, "multimodal");
      assert.equal(file.fileId, "file-1");
      assert.equal(file.width, 10);
      assert.equal(file.height, 20);
      assert.deepEqual(calls, ["/backend-api/files", "/upload", "/backend-api/files/file-1/uploaded"]);
    },
  );
});

test("uploadFile uses the my_files use case for non-image mime types", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/files") return Response.json({ upload_url: "https://blob.example/upload", file_id: "f2" });
      if (u.href === "https://blob.example/upload") return new Response(null, { status: 200 });
      return Response.json({});
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const file = await client.uploadFile({ data: new Uint8Array([1]), fileName: "doc.pdf", mimeType: "application/pdf" });
      assert.equal(file.useCase, "my_files");
      assert.equal(file.width, undefined);
    },
  ));

test("uploadFile throws when the create response is missing upload_url/file_id", () =>
  withFetch(
    async () => Response.json({}),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(
        client.uploadFile({ data: new Uint8Array([1]), fileName: "a", mimeType: "text/plain" }),
        /did not contain upload_url and file_id/,
      );
    },
  ));

test("uploadFile throws when the blob upload itself fails", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/files") return Response.json({ upload_url: "https://blob.example/upload", file_id: "f3" });
      return new Response("nope", { status: 500 });
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(
        client.uploadFile({ data: new Uint8Array([1]), fileName: "a", mimeType: "text/plain" }),
        (error) => {
          assert.ok(error instanceof BackendApiError);
          assert.equal(error.status, 500);
          return true;
        },
      );
    },
  ));

// --- resolveAssetDownload --------------------------------------------------------------

test("resolveAssetDownload resolves a file-service pointer", () =>
  withFetch(
    async (url) => {
      assert.equal(new URL(String(url)).pathname, "/backend-api/files/abc/download");
      return Response.json({ download_url: "https://cdn.example/abc" });
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const url = await client.resolveAssetDownload("file-service://abc");
      assert.equal(url, "https://cdn.example/abc");
    },
  ));

test("resolveAssetDownload resolves a sediment pointer given a conversationId", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      assert.match(u.pathname, /^\/backend-api\/files\/download\/file-xyz$/);
      assert.equal(u.searchParams.get("conversation_id"), "conv-1");
      return Response.json({ download_url: "https://cdn.example/xyz" });
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const url = await client.resolveAssetDownload("sediment://blob#file-xyz", "conv-1");
      assert.equal(url, "https://cdn.example/xyz");
    },
  ));

test("resolveAssetDownload requires a conversationId for sediment pointers", () =>
  withFetch(
    async () => Response.json({}),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.resolveAssetDownload("sediment://blob#file-xyz"), /requires conversationId/);
    },
  ));

test("resolveAssetDownload rejects unsupported pointer schemes", () =>
  withFetch(
    async () => Response.json({}),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.resolveAssetDownload("https://not-a-real-scheme/x"), /Unsupported asset pointer/);
    },
  ));

test("resolveAssetDownload throws when metadata has no download_url", () =>
  withFetch(
    async () => Response.json({}),
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.resolveAssetDownload("file-service://abc"), /no download_url/);
    },
  ));

// --- sendMessage: Work Mode rejection, prepareFollowup, sentinelHandshake -------------

function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${p}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

const HAPPY_STREAM = () =>
  sseBody([
    JSON.stringify("v1"),
    JSON.stringify({
      p: "",
      o: "add",
      v: {
        conversation_id: "upstream-conv",
        message: { id: "assistant-1", author: { role: "assistant" }, content: { content_type: "text", parts: ["hi"] }, status: "finished_successfully" },
      },
    }),
    "[DONE]",
  ]);

test("sendMessage rejects Work Mode aliases without any network call", async () => {
  const client = new ChatGptBackendClient(fakeCreds());
  await assert.rejects(
    client.sendMessage({ prompt: "hi", model: "gpt-5-wm" }),
    (error) => {
      assert.ok(error instanceof BackendApiError);
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("sendMessage's first turn skips prepareFollowup", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/f/conversation/prepare") throw new Error("prepareFollowup must not run on the first turn");
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") return HAPPY_STREAM();
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.sendMessage({ prompt: "hi", model: "auto" });
      assert.equal(result.text, "hi");
      assert.equal(result.conversationId, "upstream-conv");
    },
  ));

test("sendMessage's follow-up turn negotiates prepareFollowup and forwards its conduit token", () => {
  const seenHeaders = [];
  return withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/f/conversation/prepare") {
        const body = JSON.parse(String(init.body));
        seenHeaders.push({ headers: init.headers, source: body.client_prepare_source });
        return body.client_prepare_source === "context_change"
          ? Response.json({ conduit_token: "conduit-A" })
          : Response.json({ conduit_token: "conduit-B" });
      }
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["x-conduit-token"], "conduit-B");
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.sendMessage({ prompt: "again", model: "auto", conversationId: "conv-1", parentMessageId: "node-1" });
      assert.equal(seenHeaders[1].headers["x-conduit-token"], "conduit-A");
    },
  );
});

test("prepareFollowup swallows a 404/409/422 on the first prepare call and proceeds with no conduit token", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/f/conversation/prepare") {
        const body = JSON.parse(String(init.body));
        if (body.client_prepare_source === "context_change") return new Response("gone", { status: 404 });
        assert.equal(init.headers["x-conduit-token"], undefined);
        return Response.json({ conduit_token: "conduit-only" });
      }
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") return HAPPY_STREAM();
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.sendMessage({ prompt: "again", model: "auto", conversationId: "conv-1" });
    },
  ));

test("prepareFollowup swallows a 400/409/422 on the second prepare call and falls back to the first conduit token", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/f/conversation/prepare") {
        const body = JSON.parse(String(init.body));
        if (body.client_prepare_source === "context_change") return Response.json({ conduit_token: "conduit-A" });
        return new Response("conflict", { status: 409 });
      }
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["x-conduit-token"], "conduit-A");
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.sendMessage({ prompt: "again", model: "auto", conversationId: "conv-1" });
    },
  ));

test("prepareFollowup rethrows a non-whitelisted BackendApiError status from either prepare call", async () => {
  await withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/f/conversation/prepare") return new Response("server error", { status: 500 });
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(
        client.sendMessage({ prompt: "again", model: "auto", conversationId: "conv-1" }),
        (error) => {
          assert.ok(error instanceof BackendApiError);
          assert.equal(error.status, 500);
          return true;
        },
      );
    },
  );
});

test("sentinelHandshake throws when finalize returns no requirements token", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({});
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.sendMessage({ prompt: "hi", model: "auto" }), /no requirements token/);
    },
  ));

test("sendMessage throws when /f/conversation itself fails", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") return new Response("nope", { status: 429 });
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.sendMessage({ prompt: "hi", model: "auto" }), (error) => {
        assert.equal(error.status, 429);
        return true;
      });
    },
  ));

test("sendMessage throws when the stream ends before a done marker", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation")
        return sseBody([
          JSON.stringify({
            p: "",
            o: "add",
            v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: ["partial"] } } },
          }),
        ]);
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.sendMessage({ prompt: "hi", model: "auto" }), /interrupted before completion/);
    },
  ));

test("sendMessage throws when the stream reports an error_code", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation")
        return sseBody([JSON.stringify({ p: "", o: "add", v: { error_code: "content_filter" } }), "[DONE]"]);
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.sendMessage({ prompt: "hi", model: "auto" }), /error_code=content_filter/);
    },
  ));

test("sendMessage throws a clear error when a completed stream never produced an assistant node or an error_code", () =>
  withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      // A stream that reaches [DONE] having emitted no "add" event at all -
      // e.g. an upstream response that is technically well-formed SSE but
      // carries nothing recognizable - must not be treated as a silent
      // success with an empty reply.
      if (u.pathname === "/backend-api/f/conversation") return sseBody(["[DONE]"]);
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await assert.rejects(client.sendMessage({ prompt: "hi", model: "auto" }), /no assistant node was received/);
    },
  ));

test("sendMessage attaches a real sentinel proof token when proof-of-work is required", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare")
        return Response.json({ prepare_token: "p", proofofwork: { required: true, seed: "seed", difficulty: "f" } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") {
        const body = JSON.parse(String(init.body));
        assert.match(body.proofofwork, /^gAAAAAB/);
        return Response.json({ token: "final" });
      }
      if (u.pathname === "/backend-api/f/conversation") {
        assert.match(init.headers["openai-sentinel-proof-token"], /^gAAAAAB/);
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.sendMessage({ prompt: "hi", model: "auto" });
    },
  ));

test("sendMessage builds a multimodal user message and forwards attachments", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") {
        const body = JSON.parse(String(init.body));
        const message = body.messages[0];
        assert.equal(message.content.content_type, "multimodal_text");
        assert.equal(message.content.parts.length, 2);
        assert.equal(message.metadata.attachments[0].id, "file-1");
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      await client.sendMessage({
        prompt: "check this out",
        model: "auto",
        attachments: [{ fileId: "file-1", fileName: "a.png", fileSize: 3, mimeType: "image/png", useCase: "multimodal", width: 4, height: 5, raw: {} }],
      });
    },
  ));

// --- ChatGptConversationSession -------------------------------------------------------

test("ChatGptConversationSession initializes once, resolves auto model, and tracks state across sends", () => {
  let initCalls = 0;
  return withFetch(
    async (url) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/conversation/init") {
        initCalls += 1;
        return Response.json({ default_model_slug: "gpt-4o" });
      }
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare") return Response.json({ prepare_token: "p", proofofwork: { required: false } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") return Response.json({ token: "final" });
      if (u.pathname === "/backend-api/f/conversation") return HAPPY_STREAM();
      // A second send() has a conversationId already, so it goes through
      // prepareFollowup's context-change + composer-state prepare calls
      // (both hit this same endpoint) before the actual conduit send.
      if (u.pathname === "/backend-api/f/conversation/prepare") return Response.json({ conduit_token: null });
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const session = client.conversation({ conversationId: null, currentNodeId: "client-created-root", model: "auto", gizmoId: null, initialized: false }, { some: "gizmo" });
      assert.ok(session instanceof ChatGptConversationSession);
      const first = await session.send("hello");
      assert.equal(session.state.model, "gpt-4o");
      assert.equal(session.state.initialized, true);
      assert.equal(session.state.conversationId, "upstream-conv");
      assert.equal(session.state.currentNodeId, "assistant-1");
      assert.equal(first.text, "hi");

      // Second send should not re-initialize.
      await session.send("again");
      assert.equal(initCalls, 1);
    },
  );
});

// --- newDeviceId ------------------------------------------------------------------------

test("newDeviceId returns a fresh UUID each call", () => {
  const a = newDeviceId();
  const b = newDeviceId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
});

test("empty JSON bodies are rejected for both GET and POST", async () => {
  await withFetch(async () => new Response(""), async () => {
    const client = new ChatGptBackendClient(fakeCreds());
    await assert.rejects(client.fetchMe(), /non-object JSON/);
    await assert.rejects(client.initConversation({ timezone: "UTC", timezoneOffsetMin: 0 }), /non-object JSON/);
  });
});

test("listing defaults and sediment identifiers are serialized consistently", async () => {
  const urls = [];
  await withFetch(async url => { urls.push(new URL(url)); return Response.json({ download_url: "https://example.test/file" }); }, async () => {
    const client = new ChatGptBackendClient(fakeCreds());
    await client.fetchGizmoSidebar();
    await client.fetchGizmoBootstrap();
    await client.fetchConversations();
    assert.equal(await client.resolveAssetDownload("sediment://opaque-id", "conversation"), "https://example.test/file");
  });
  assert.equal(urls[0].searchParams.get("owned_only"), "true");
  assert.equal(urls[0].searchParams.get("conversations_per_gizmo"), "5");
  assert.equal(urls[0].searchParams.get("limit"), "50");
  assert.equal(urls[1].searchParams.get("limit"), "20");
  assert.equal(urls[2].searchParams.get("is_archived"), "false");
  assert.match(urls[3].pathname, /opaque-id$/);
});

for (const failure of [new BackendApiError("missing status"), new Error("transport failed")]) {
  for (const step of [1, 2]) {
    test(`followup propagates ${failure.message} at prepare step ${step}`, async () => {
      let calls = 0;
      await withFetch(async () => { if (++calls === step) throw failure; return Response.json({ conduit_token: "first" }); }, async () => {
        const client = new ChatGptBackendClient(fakeCreds());
        await assert.rejects(client.sendMessage({ model: "auto", prompt: "next", conversationId: "existing" }), error => error === failure);
      });
      assert.equal(calls, step);
    });
  }
}

test("stream EOF flushes an unterminated final frame and bootstraps a gizmo payload", async () => {
  let sent;
  const config = [1, "date", null, 0, null, "url", "deploy", "en", "en-US", null, "plugins", "react", "event"];
  await withFetch(async (url, init) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prepare")) return Response.json({ proofofwork: { required: false, dx: "gAAAAAB" + Buffer.from(JSON.stringify(config)).toString("base64") } });
    if (pathname.endsWith("/finalize")) return Response.json({ token: "fixture" });
    sent = JSON.parse(init.body);
    return new Response('data: {"p":"","o":"add","v":{"message":{"id":"answer","author":{"role":"assistant"},"content":{"parts":["tail"]}}}}\n\ndata: [DONE]');
  }, async () => {
    const result = await new ChatGptBackendClient(fakeCreds()).sendMessage({ model: "auto", prompt: "hello", gizmoId: "g-fixture", gizmoPayload: { id: "g-fixture" } });
    assert.equal(result.text, "tail");
    assert.deepEqual(sent.conversation_mode.gizmo, { id: "g-fixture" });
  });
});

test("absent proof requirements still allow the ordinary handshake", async () => {
  await withFetch(async url => {
    if (new URL(url).pathname.endsWith("/prepare")) return Response.json({});
    if (new URL(url).pathname.endsWith("/finalize")) return Response.json({ token: "fixture" });
    return HAPPY_STREAM();
  }, async () => assert.equal((await new ChatGptBackendClient(fakeCreds()).sendMessage({ model: "auto", prompt: "hi" })).text, "hi"));
});

test("conversation initialization preserves explicit models and uses the intended default when available", async () => {
  for (const [model, init, expected] of [
    ["explicit", { default_model_slug: "default" }, "explicit"],
    ["auto", { intended_default_model_slug: "intended" }, "intended"],
    ["auto", {}, "auto"],
  ]) {
    await withFetch(async () => Response.json(init), async () => {
      const session = new ChatGptBackendClient(fakeCreds()).conversation({ model, conversationId: null, currentNodeId: "root", initialized: false, gizmoId: null });
      await session.initialize("UTC", 0);
      assert.equal(session.state.model, expected);
      assert.equal(session.state.initialized, true);
    });
  }
});

test("sandbox downloads require an absolute path, conversation and message before making requests", async () => {
  await withFetch(async () => assert.fail("Invalid sandbox input must not make a request"), async () => {
    const client = new ChatGptBackendClient(fakeCreds());
    for (const args of [["/file", null, "message"], ["/file", "conversation", null], ["relative", "conversation", "message"]]) {
      await assert.rejects(client.resolveSandboxDownload(...args), /requires conversation, message and absolute path/);
    }
  });
  await withFetch(async () => Response.json({}), async () => {
    await assert.rejects(new ChatGptBackendClient(fakeCreds()).resolveSandboxDownload("/file", "conversation", "message"), /no download_url/);
  });
});

test("sentinelHandshake passes null turnstile when no token is configured", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare")
        return Response.json({ prepare_token: "p", proofofwork: { required: false }, turnstile: { required: true } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.turnstile, null);
        return Response.json({ token: "final" });
      }
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["openai-sentinel-turnstile-token"], undefined);
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.sendMessage({ prompt: "hi", model: "auto" });
      assert.equal(result.text, "hi");
    },
  ));

test("sentinelHandshake consumes a turnstile override only during finalize", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare")
        return Response.json({ prepare_token: "p", proofofwork: { required: false }, turnstile: { required: true } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.turnstile, "my-turnstile-token");
        return Response.json({ token: "final" });
      }
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["openai-sentinel-turnstile-token"], undefined);
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      const result = await client.sendMessage({ prompt: "hi", model: "auto", turnstileToken: "my-turnstile-token" });
      assert.equal(result.text, "hi");
    },
  ));

test("sentinelHandshake consumes a credentials turnstileToken during finalize", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare")
        return Response.json({ prepare_token: "p", proofofwork: { required: false }, turnstile: { required: true } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.turnstile, "cred-turnstile");
        return Response.json({ token: "final" });
      }
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["openai-sentinel-turnstile-token"], undefined);
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const creds = { ...fakeCreds(), turnstileToken: "cred-turnstile" };
      const client = new ChatGptBackendClient(creds);
      const result = await client.sendMessage({ prompt: "hi", model: "auto" });
      assert.equal(result.text, "hi");
    },
  ));

test("sentinelHandshake uses client.turnstileSolver callback", () =>
  withFetch(
    async (url, init = {}) => {
      const u = new URL(String(url));
      if (u.pathname === "/backend-api/sentinel/chat-requirements/prepare")
        return Response.json({ prepare_token: "p", proofofwork: { required: false }, turnstile: { required: true, dx: "challenge-dx" } });
      if (u.pathname === "/backend-api/sentinel/chat-requirements/finalize") {
        const body = JSON.parse(String(init.body));
        assert.equal(body.turnstile, "solved-by-cb");
        return Response.json({ token: "final" });
      }
      if (u.pathname === "/backend-api/f/conversation") {
        assert.equal(init.headers["openai-sentinel-turnstile-token"], undefined);
        return HAPPY_STREAM();
      }
      throw new Error(`unexpected ${u.href}`);
    },
    async () => {
      const client = new ChatGptBackendClient(fakeCreds());
      client.turnstileSolver = async (challenge) => {
        assert.equal(challenge.required, true);
        assert.equal(challenge.dx, "challenge-dx");
        return "solved-by-cb";
      };
      const result = await client.sendMessage({ prompt: "hi", model: "auto" });
      assert.equal(result.text, "hi");
    },
  ));
});
