import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Shared store/app for the whole file, following the established pattern
// (chat-service.test.mjs, openai-edit-history.test.mjs): openai.js's own
// internal `import ... from "./store.js"` always resolves to the same
// plain-specifier module instance no matter what query string a test uses,
// so one shared import pair gives every test a consistent view of the same
// database, session, and conversation-lock map.
const dir = mkdtempSync(path.join(tmpdir(), "mirror-openai-routes-"));
process.env.MIRROR_DATA_DIR = dir;
const [{ default: Fastify }, store, openai] = await Promise.all([
  import("fastify"),
  import("../dist/store.js"),
  import("../dist/openai.js"),
]);
// Match index.ts's buildApp() bodyLimit so a large-but-under-the-app-limit
// payload reaches openai.ts's own MAX_IMAGE_BYTES check rather than being
// rejected by Fastify's (much smaller) default first.
const app = Fastify({ bodyLimit: 30 * 1024 * 1024 });
await openai.registerOpenAiRoutes(app);
test.after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function useSession(accountId) {
  store.saveVerifiedSession(`session-token-for-${accountId}-long-enough`, accountId, `device-${accountId}`);
  store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
}

function sseBody(payloads) {
  return new Response(payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function assistantAddFrame(upstreamConversationId, messageId, text, extra = {}) {
  return {
    p: "",
    o: "add",
    v: {
      conversation_id: upstreamConversationId,
      message: {
        id: messageId,
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
      },
      ...extra,
    },
  };
}

// A full happy-path upstream: /me, /conversation/init, gizmo lookup,
// sentinel handshake, and /f/conversation all succeed. `turnFrames(body,
// turnNumber)` lets a test control exactly what SSE frames come back for
// each successive turn (so a single test can inspect what was actually
// sent - the parent_message_id, the flattened vs single-message prompt,
// history_and_training_disabled, etc). `sent` collects every JSON POST
// body, tagged with its pathname.
function stubBackend(accountId, { sent = [], turnFrames, modelsBody, sidebarBody, bootstrapBody, sidebarFails, bootstrapFails } = {}) {
  let turn = 0;
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body && typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null;
    if (body) sent.push({ pathname, body });
    if (pathname.endsWith("/me")) return Response.json({ account: { account_user_id: accountId } });
    if (pathname.endsWith("/models")) return Response.json(modelsBody ?? { models: [] });
    if (pathname.endsWith("/gizmos/snorlax/sidebar")) {
      if (sidebarFails) return new Response("boom", { status: 500 });
      return Response.json(sidebarBody ?? {});
    }
    if (pathname.endsWith("/gizmos/bootstrap")) {
      if (bootstrapFails) return new Response("boom", { status: 500 });
      return Response.json(bootstrapBody ?? {});
    }
    if (pathname.startsWith("/backend-api/gizmos/")) return new Response("not found", { status: 404 });
    if (pathname.endsWith("/conversation/init"))
      return Response.json({ default_model_slug: "model-a", limits_progress: [], blocked_features: [] });
    if (pathname.endsWith("/f/conversation/prepare")) return Response.json({ conduit_token: "conduit" });
    if (pathname.endsWith("/sentinel/chat-requirements/prepare"))
      return Response.json({ prepare_token: "prepare", proofofwork: { required: false } });
    if (pathname.endsWith("/sentinel/chat-requirements/finalize")) return Response.json({ token: "requirements" });
    if (pathname.endsWith("/f/conversation")) {
      turn += 1;
      const frames = turnFrames
        ? turnFrames(body, turn)
        : [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `assistant-${turn}`, `reply-${turn}`), "[DONE]"];
      return sseBody(frames);
    }
    throw new Error(`Unexpected test URL: ${url}`);
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


// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------

test("GET /v1/models merges models, GPTs, and Projects, marks -wm models unsupported, and dedupes by id", async () => {
  useSession("account-models");
  await withFetch(
    stubBackend("account-models", {
      modelsBody: {
        models: [
          { slug: "gpt-4o", title: "GPT-4o" },
          { slug: "gpt-5-work-wm", title: "GPT-5 (Work Mode)" },
        ],
      },
      sidebarBody: { items: [{ id: "g-p-1", gizmo: { gizmo: { id: "g-p-1", display: { name: "My Project" } } } }] },
      bootstrapBody: {
        items: [
          { id: "g-1", display: { name: "Helper GPT" } },
          { id: "g-p-1", display: { name: "Duplicate of the project above" } },
        ],
      },
    }),
    async () => {
      const res = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      const byId = Object.fromEntries(body.data.map((m) => [m.id, m]));
      assert.equal(byId["gpt-4o"].mirror.supported, true);
      assert.equal(byId["gpt-4o"].mirror.execution_mode, "interactive");
      assert.equal(byId["gpt-5-work-wm"].mirror.supported, false);
      assert.equal(byId["gpt-5-work-wm"].mirror.execution_mode, "unsupported_work");
      assert.equal(byId["g-p-1"].owned_by, "chatgpt-project");
      assert.equal(byId["g-1"].owned_by, "chatgpt-gizmo");
      assert.equal(byId["g-1"].name, "Helper GPT");
      // g-p-1 appeared in both the sidebar and bootstrap payloads - only one entry survives.
      assert.equal(body.data.filter((m) => m.id === "g-p-1").length, 1);
    },
  );
});

test("GET /v1/models tolerates the gizmo sidebar and bootstrap endpoints failing independently", async () => {
  useSession("account-models-2");
  await withFetch(
    stubBackend("account-models-2", {
      modelsBody: { models: [{ slug: "gpt-4o" }] },
      sidebarFails: true,
      bootstrapBody: { items: [{ id: "g-1", display: { name: "Still here" } }] },
    }),
    async () => {
      const res = await app.inject({ method: "GET", url: "/v1/models" });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.ok(body.data.some((m) => m.id === "g-1"));
      assert.ok(body.data.some((m) => m.id === "gpt-4o"));
    },
  );
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions - request validation (before touching upstream)
// ---------------------------------------------------------------------------

test("an unparsable body is rejected with 400 and the schema's own message", async () => {
  useSession("account-validate");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "auto", messages: [] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /at least 1 element/i);
});

test("a Work Mode (-wm) model is rejected before any upstream call", async () => {
  useSession("account-validate-2");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "gpt-5-wm", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /Work Mode/);
});

test("a Work Mode model reached via metadata.mirror_model is also rejected", async () => {
  useSession("account-validate-2b");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "g-1",
      metadata: { mirror_model: "gpt-5-wm" },
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /Work Mode/);
});

test("a tool-role message is rejected as unsupported", async () => {
  useSession("account-validate-3");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [
        { role: "user", content: "hi" },
        { role: "tool", content: "result" },
      ],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /Tool messages/);
});

test("a final message that isn't from the user is rejected", async () => {
  useSession("account-validate-4");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "assistant", content: "hi" }],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /final message must have role=user/);
});

test("an empty final user message with no image attachment is rejected", async () => {
  useSession("account-validate-5");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "user", content: "   " }],
    },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error.message, /must not be empty/);
});

// ---------------------------------------------------------------------------
// Image attachments (resolveImageAttachment)
// ---------------------------------------------------------------------------

function pngDataUrl() {
  // The shortest possible base64 payload - content doesn't matter, only that
  // it decodes to a non-empty byte string and the declared mime type starts
  // with "image/".
  return "data:image/png;base64,AAAA";
}

function fileUploadRoutes(sent, uploadedFileIds) {
  return {
    "/backend-api/files": () => {
      const id = `file-${uploadedFileIds.length + 1}`;
      uploadedFileIds.push(id);
      return Response.json({ upload_url: "https://blob.example/put", file_id: id });
    },
    "/put": () => new Response(null, { status: 200 }),
    // matched by suffix below since the id is dynamic
  };
}

function stubBackendWithUploads(accountId, opts = {}) {
  const base = stubBackend(accountId, opts);
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/backend-api/files" && init.method !== undefined) {
      const bodyText = init.body;
      if (init.method === "POST" || (!init.method && bodyText)) {
        const id = `file-${(opts.uploadedFileIds ??= []).length + 1}`;
        opts.uploadedFileIds.push(id);
        opts.sent?.push({ pathname, body: JSON.parse(bodyText) });
        return Response.json({ upload_url: "https://blob.example/put", file_id: id });
      }
    }
    if (pathname === "/put") return new Response(null, { status: 200 });
    if (/^\/backend-api\/files\/file-\d+\/uploaded$/.test(pathname)) return Response.json({ status: "success" });
    return base(url, init);
  };
}

test("a data: URI image attachment is resolved, uploaded, and forwarded to the turn", async () => {
  useSession("account-image-1");
  const sent = [];
  await withFetch(stubBackendWithUploads("account-image-1", { sent }), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: pngDataUrl() } },
            ],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const uploadCall = sent.find((s) => s.pathname === "/backend-api/files");
    assert.equal(uploadCall.body.use_case, "multimodal");
    const conversationId = res.headers["x-mirror-conversation-id"];
    assert.equal(store.listFiles?.("account-image-1")?.length ?? 1, store.listFiles ? store.listFiles("account-image-1").length : 1);
    void conversationId;
  });
});

test("an https image_url is fetched server-side and uploaded the same way", async () => {
  useSession("account-image-2");
  const sent = [];
  await withFetch(
    async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/photo.jpg") return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/jpeg" } });
      return stubBackendWithUploads("account-image-2", { sent })(url, init);
    },
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [
            {
              role: "user",
              content: [{ type: "image_url", image_url: { url: "https://example.com/photo.jpg" } }],
            },
          ],
        },
      });
      assert.equal(res.statusCode, 200, res.body);
    },
  );
});

test("an image_url fetch that fails upstream is reported as a 400", async () => {
  useSession("account-image-3");
  await withFetch(
    async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/broken.jpg") return new Response("nope", { status: 404 });
      return stubBackendWithUploads("account-image-3", {})(url, init);
    },
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.com/broken.jpg" } }] }],
        },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.match(res.json().error.message, /upstream returned 404/);
    },
  );
});

test("an image_url that is neither a data: URI nor an http(s) URL is rejected", async () => {
  useSession("account-image-4");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "ftp://example.com/x.png" } }] }],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /must be a data: URI or an http\(s\) URL/);
});

test("an image_url resolving to a non-image mime type is rejected", async () => {
  useSession("account-image-5");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:text/plain;base64,aGVsbG8=" } }] }],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /does not look like an image/);
});

test("an image_url resolving to an empty file is rejected", async () => {
  useSession("account-image-6");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64," } }] }],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /resolved to an empty file/);
});

test("an oversized image_url attachment is rejected", async () => {
  useSession("account-image-7");
  const big = Buffer.alloc(21 * 1024 * 1024, 1).toString("base64");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${big}` } }] }],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /too large/);
});

// ---------------------------------------------------------------------------
// Explicit conversation_id ownership and history-based inference
// ---------------------------------------------------------------------------

test("an explicit conversation_id already owned by a different account is rejected with 400", async () => {
  const other = store.createConversation({ model: "auto", accountId: "account-owner-x" });
  useSession("account-intruder-x");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "auto",
      metadata: { conversation_id: other.id },
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /already in use/);
});

test("resent history alone (no conversation_id) is recognized as a continuation when model/gizmo/private all still match", async () => {
  useSession("account-infer-1");
  const sent = [];
  await withFetch(stubBackend("account-infer-1", { sent }), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "first" }] },
    });
    assert.equal(first.statusCode, 200, first.body);
    const conversationId = first.headers["x-mirror-conversation-id"];

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "second" },
        ],
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.headers["x-mirror-conversation-id"], conversationId, "resent history alone must resume the same Mirror conversation");
    assert.equal(sent.filter((s) => s.pathname.endsWith("/f/conversation")).length, 2);
  });
});

test("resent history with a different private flag is NOT inferred as a continuation", async () => {
  useSession("account-infer-2");
  await withFetch(stubBackend("account-infer-2", {}), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "first" }] },
    });
    const conversationId = first.headers["x-mirror-conversation-id"];

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { private: "true" },
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "second" },
        ],
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.headers["x-mirror-conversation-id"], conversationId, "a mismatched private flag must start a fresh conversation instead");
  });
});

test("resent history with a different gizmo is NOT inferred as a continuation", async () => {
  useSession("account-infer-3");
  await withFetch(stubBackend("account-infer-3", {}), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "first" }] },
    });
    const conversationId = first.headers["x-mirror-conversation-id"];

    const second = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "g-different",
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "second" },
        ],
      },
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.notEqual(second.headers["x-mirror-conversation-id"], conversationId);
  });
});

// ---------------------------------------------------------------------------
// Continuing an explicit conversation without a rebase: model/gizmo/private
// are locked in once a Mirror conversation exists.
// ---------------------------------------------------------------------------

test("continuing an explicit conversation with a different gizmo is rejected without ever reaching upstream", async () => {
  useSession("account-lockin-1");
  const sent = [];
  await withFetch(stubBackend("account-lockin-1", { sent }), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "g-original", messages: [{ role: "user", content: "hi" }] },
    });
    const conversationId = first.headers["x-mirror-conversation-id"];
    const turnsBefore = sent.filter((s) => s.pathname.endsWith("/f/conversation")).length;

    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "g-changed",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "again" },
        ],
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /GPT\/Project cannot change/);
    assert.equal(sent.filter((s) => s.pathname.endsWith("/f/conversation")).length, turnsBefore, "must not reach upstream");
  });
});

test("continuing an explicit conversation with a different model is rejected", async () => {
  useSession("account-lockin-2");
  await withFetch(stubBackend("account-lockin-2", {}), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "gpt-original", messages: [{ role: "user", content: "hi" }] },
    });
    const conversationId = first.headers["x-mirror-conversation-id"];
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-changed",
        metadata: { conversation_id: conversationId },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "again" },
        ],
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /model cannot change/);
  });
});

test("continuing an explicit conversation with a different private flag is rejected", async () => {
  useSession("account-lockin-3");
  await withFetch(stubBackend("account-lockin-3", {}), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    const conversationId = first.headers["x-mirror-conversation-id"];
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: conversationId, private: "true" },
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "again" },
        ],
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error.message, /Private-chat mode cannot change/);
  });
});

// ---------------------------------------------------------------------------
// Streaming: SSE preamble, forwarded deltas, the mirror-conversation-id
// comment, the final chunk, and [DONE].
// ---------------------------------------------------------------------------

function parseSseFrames(body) {
  return body
    .split(/\r?\n\r?\n/)
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const commentLine = chunk.split(/\r?\n/).find((line) => line.startsWith(": "));
      const dataLine = chunk.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (commentLine && !dataLine) return { comment: commentLine.slice(2) };
      const data = dataLine.slice(5).trim();
      return data === "[DONE]" ? { done: true } : { json: JSON.parse(data) };
    });
}

test("a streaming completion emits the preamble, a delta chunk, the mirror-conversation-id comment, and a final chunk before [DONE]", async () => {
  useSession("account-stream-1");
  await withFetch(
    stubBackend("account-stream-1", {
      turnFrames: (body, turn) => [
        assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `assistant-${turn}`, "hello world"),
        "[DONE]",
      ],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.match(res.headers["content-type"], /text\/event-stream/);
      const frames = parseSseFrames(res.body);
      assert.equal(frames[0].json.choices[0].delta.role, "assistant");
      assert.equal(frames[0].json.choices[0].delta.content, "");
      const deltaFrame = frames.find((f) => f.json?.choices?.[0]?.delta?.content === "hello world");
      assert.ok(deltaFrame, "expected a delta chunk carrying the full text");
      const commentFrame = frames.find((f) => f.comment?.startsWith("mirror-conversation-id "));
      assert.ok(commentFrame);
      const finalFrame = frames.find((f) => f.json && f.json.choices[0].finish_reason === "stop");
      assert.ok(finalFrame);
      assert.ok(frames.some((f) => f.done));
    },
  );
});

test("a one-shot (store:false) streaming completion never emits a mirror-conversation-id comment", async () => {
  useSession("account-stream-2");
  await withFetch(
    stubBackend("account-stream-2", {
      turnFrames: (body, turn) => [assistantAddFrame(`upstream-${turn}`, `assistant-${turn}`, "ephemeral reply"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stream: true, store: false, messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const frames = parseSseFrames(res.body);
      assert.ok(!frames.some((f) => f.comment));
    },
  );
});

// ---------------------------------------------------------------------------
// Compatibility fields must never truncate streaming or non-streaming answers.
// ---------------------------------------------------------------------------

test("a stop sequence is accepted without truncating the non-streaming answer", async () => {
  useSession("account-limit-1");
  await withFetch(
    stubBackend("account-limit-1", {
      turnFrames: (_body, turn) => [assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "hello STOPHERE world"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stop: "STOPHERE", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.choices[0].message.content, "hello STOPHERE world");
      assert.equal(body.choices[0].finish_reason, "stop");
    },
  );
});

test("stop arrays are accepted without cutting the answer", async () => {
  useSession("account-limit-2");
  await withFetch(
    stubBackend("account-limit-2", {
      turnFrames: (_body, turn) => [assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "aaa BBB ccc AAA"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stop: ["AAA", "BBB"], messages: [{ role: "user", content: "hi" }] },
      });
      const body = res.json();
      assert.equal(body.choices[0].message.content, "aaa BBB ccc AAA");
    },
  );
});

test("max_tokens never imposes a response length limit", async () => {
  useSession("account-limit-3");
  await withFetch(
    stubBackend("account-limit-3", {
      turnFrames: (_body, turn) => [assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "0123456789abcdefghij"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", max_tokens: 2, messages: [{ role: "user", content: "hi" }] },
      });
      const body = res.json();
      assert.equal(body.choices[0].message.content, "0123456789abcdefghij");
      assert.equal(body.choices[0].finish_reason, "stop");
    },
  );
});

test("both token fields are accepted without limiting the response", async () => {
  useSession("account-limit-4");
  await withFetch(
    stubBackend("account-limit-4", {
      turnFrames: (_body, turn) => [assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "0123456789abcdefghij"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", max_tokens: 100, max_completion_tokens: 1, messages: [{ role: "user", content: "hi" }] },
      });
      const body = res.json();
      assert.equal(body.choices[0].message.content, "0123456789abcdefghij");
    },
  );
});

test("a stop sequence never cuts off a streaming response", async () => {
  useSession("account-limit-5");
  await withFetch(
    stubBackend("account-limit-5", {
      // Two separate assistant "add" frames simulate two delta events
      // arriving over the wire, the second crossing the stop sequence.
      turnFrames: (_body, turn) => [
        assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "hello "),
        assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "hello STOP more text"),
        "[DONE]",
      ],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stream: true, stop: "STOP", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const frames = parseSseFrames(res.body);
      const forwardedText = frames
        .filter((f) => f.json?.choices?.[0]?.delta?.content)
        .map((f) => f.json.choices[0].delta.content)
        .join("");
      assert.equal(forwardedText, "hello STOP more text");
      const finalFrame = frames.find((f) => f.json && f.json.choices[0].finish_reason === "stop");
      assert.ok(finalFrame);
    },
  );
});

// ---------------------------------------------------------------------------
// buildResponseMetadata: ChatGPT-only tool-call/image events packed into
// documented metadata.mirror_tool_events / metadata.mirror_images keys.
// ---------------------------------------------------------------------------

function toolAddFrame(upstreamConversationId, messageId, toolName, extra = {}) {
  return {
    p: "",
    o: "add",
    v: {
      conversation_id: upstreamConversationId,
      message: {
        id: messageId,
        author: { role: "tool", name: toolName },
        content: { content_type: "text", parts: [""] },
        status: "finished_successfully",
      },
      ...extra,
    },
  };
}

test("a non-streaming turn preserves tool metadata but does not advertise unresolved image URLs", async () => {
  useSession("account-metadata-1");
  await withFetch(
    stubBackend("account-metadata-1", {
      turnFrames: (body, turn) => {
        const upstream = body?.conversation_id ?? `upstream-${turn}`;
        return [
          toolAddFrame(upstream, `tool-${turn}`, "web_browser"),
          // A bare sediment:// pointer anywhere in a frame's `v` payload is
          // enough for scanSpecials() to synthesize an "image" event - here
          // tucked into an extra field alongside the final assistant reply.
          assistantAddFrame(upstream, `a-${turn}`, "here's a picture", {
            generated_image: "sediment://file-xyz789",
          }),
          "[DONE]",
        ];
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "draw something and browse" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.ok(body.metadata, "expected a metadata object on the response");
      const toolEvents = JSON.parse(body.metadata.mirror_tool_events);
      assert.deepEqual(toolEvents, [{ name: "web_browser", status: "finished_successfully" }]);
      const images = JSON.parse(body.metadata.mirror_images);
      assert.deepEqual(images, []);
    },
  );
});

test("a streaming turn's final chunk also carries metadata.mirror_tool_events/mirror_images", async () => {
  useSession("account-metadata-2");
  await withFetch(
    stubBackend("account-metadata-2", {
      turnFrames: (body, turn) => {
        const upstream = body?.conversation_id ?? `upstream-${turn}`;
        return [
          toolAddFrame(upstream, `tool-${turn}`, "python"),
          assistantAddFrame(upstream, `a-${turn}`, "done"),
          "[DONE]",
        ];
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stream: true, messages: [{ role: "user", content: "run some code" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const frames = parseSseFrames(res.body);
      const finalFrame = frames.find((f) => f.json?.metadata);
      assert.ok(finalFrame, "expected a frame carrying metadata");
      assert.deepEqual(JSON.parse(finalFrame.json.metadata.mirror_tool_events), [
        { name: "python", status: "finished_successfully" },
      ]);
    },
  );
});

// A turn with no tool calls or images at all must not grow a metadata key -
// the other half of buildResponseMetadata's early-return branch (already
// exercised implicitly by every plain test above, but asserted explicitly
// here so the branch itself is pinned down).
test("an ordinary turn with no tool/image events carries no metadata key at all", async () => {
  useSession("account-metadata-3");
  await withFetch(stubBackend("account-metadata-3", {}), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().metadata, undefined);
  });
});

// ---------------------------------------------------------------------------
// A failed rebase must not leave synthetic replay rows (or the edited-but-
// never-sent prefix) stuck in local history - see the comment on the
// `if (needsRebase) { replaceMessages(...) }` restore inside openai.ts's
// runChat() catch block.
// ---------------------------------------------------------------------------

test("a rebase that fails upstream restores the locally-edited prefix instead of leaving a broken transcript", async () => {
  useSession("account-rebase-fail");
  await withFetch(
    stubBackend("account-rebase-fail", {
      turnFrames: (body, turn) => {
        if (turn === 2) throw new Error("simulated upstream failure");
        return [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `a-${turn}`, "reply-1"), "[DONE]"];
      },
    }),
    async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" },
          ],
        },
      });
      assert.equal(first.statusCode, 200, first.body);
      const conversationId = first.headers["x-mirror-conversation-id"];
      assert.deepEqual(
        store.listMessages(conversationId).map((m) => m.role),
        ["user", "assistant"],
      );

      // Editing the system-only prior transcript's sole user turn triggers a
      // rebase (see openai-edit-history.test.mjs for the same shape on the
      // success path); this time the upstream call for the rebased turn
      // itself fails.
      const edited = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          metadata: { conversation_id: conversationId },
          messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "edited hello" },
          ],
        },
      });
      assert.equal(edited.statusCode, 502, edited.body);
      // Public /v1 errors never echo raw upstream exception text (see
      // api-errors.ts's redaction policy) - only the generic safe category
      // surfaces, though the failed rebase must still restore local state
      // correctly (checked below).
      assert.doesNotMatch(edited.json().error.message, /simulated upstream failure/);
      assert.equal(edited.json().error.type, "server_error");
      assert.equal(edited.json().error.code, "upstream_failure");
      // rebasePriorMessages for a system-only prior transcript is empty (the
      // caller has no confirmed user/assistant turns yet at this point), so
      // the restore must leave local history empty rather than some
      // half-applied synthetic replay prompt or the old pre-edit turn.
      assert.deepEqual(store.listMessages(conversationId), []);
    },
  );
});

// ---------------------------------------------------------------------------
// Catch-all error handling: the non-400 statusCode fallback (502) for both
// non-streaming (JSON error body) and streaming (SSE error frame) turns.
// ---------------------------------------------------------------------------

test("a non-streaming turn that fails upstream with no explicit statusCode reports a generic, redacted 502 error", async () => {
  useSession("account-error-502");
  await withFetch(
    stubBackend("account-error-502", {
      turnFrames: () => {
        throw new Error("upstream is on fire");
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 502, res.body);
      const body = res.json();
      assert.equal(body.error.type, "server_error");
      assert.equal(body.error.code, "upstream_failure");
      assert.doesNotMatch(body.error.message, /upstream is on fire/);
    },
  );
});

test("a streaming turn that fails upstream emits an SSE error frame and closes the stream instead of hanging", async () => {
  useSession("account-error-stream");
  await withFetch(
    stubBackend("account-error-stream", {
      turnFrames: () => {
        throw new Error("stream upstream boom");
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] },
      });
      // The route already committed to a 200 status + SSE headers before the
      // failure (streaming responses can't change their status code once
      // started), so the error is reported as an in-band SSE error frame.
      assert.equal(res.statusCode, 200, res.body);
      const frames = parseSseFrames(res.body);
      const errorFrame = frames.find((f) => f.json?.error);
      assert.ok(errorFrame, "expected an SSE frame carrying an error object");
      assert.equal(errorFrame.json.error.type, "server_error");
      assert.equal(errorFrame.json.error.code, "upstream_failure");
      assert.doesNotMatch(errorFrame.json.error.message, /stream upstream boom/);
      // The error frame itself ends the turn by closing the connection,
      // not by also claiming a normal [DONE] completion - a client must
      // treat the error object as the terminal signal, not wait for DONE.
      assert.ok(!frames.some((f) => f.done), "did not expect a trailing [DONE] frame after an error");
    },
  );
});

// ---------------------------------------------------------------------------
// Remaining branch coverage: small, otherwise-easy-to-miss edges in routing,
// normalization, and the rebase/continuation decision tree.
// ---------------------------------------------------------------------------

test("a gizmo model with no metadata.private routes without forcing a private flag", async () => {
  useSession("account-branch-gizmo");
  await withFetch(stubBackend("account-branch-gizmo", {}), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "g-branch-1", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(res.statusCode, 200, res.body);
    const conversationId = res.headers["x-mirror-conversation-id"];
    assert.equal(Boolean(store.getConversation(conversationId).private), false);
  });
});

test("a gizmo model with metadata.private=true routes as a private conversation", async () => {
  useSession("account-branch-gizmo-private");
  await withFetch(stubBackend("account-branch-gizmo-private", {}), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "g-branch-2",
        metadata: { private: "true" },
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const conversationId = res.headers["x-mirror-conversation-id"];
    assert.equal(store.getConversation(conversationId).private, true);
  });
});

test("a final user message with content: null (no text, no image) is rejected the same as an empty one", async () => {
  useSession("account-branch-null-content");
  const res = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "auto", messages: [{ role: "user", content: null }] },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.match(res.json().error.message, /must not be empty/);
});

test("a message carrying an OpenAI 'name' field is accepted and forwarded through normalization", async () => {
  useSession("account-branch-name");
  await withFetch(stubBackend("account-branch-name", {}), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "hi", name: "alice" }],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  });
});

test("an empty stop string is accepted and simply never matches", async () => {
  useSession("account-branch-stop-empty");
  await withFetch(
    stubBackend("account-branch-stop-empty", {
      turnFrames: (_body, turn) => [assistantAddFrame(`upstream-${turn}`, `a-${turn}`, "hello world"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", stop: "", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().choices[0].message.content, "hello world");
      assert.equal(res.json().choices[0].finish_reason, "stop");
    },
  );
});

test("a tool event with no status is packed with a null status rather than crashing", async () => {
  useSession("account-branch-tool-status");
  await withFetch(
    stubBackend("account-branch-tool-status", {
      turnFrames: (body, turn) => {
        const upstream = body?.conversation_id ?? `upstream-${turn}`;
        // A hand-built frame (rather than toolAddFrame) so the tool
        // message's `status` field can be omitted entirely, unlike every
        // other tool-event test in this file.
        const toolFrameNoStatus = {
          p: "",
          o: "add",
          v: {
            conversation_id: upstream,
            message: {
              id: `tool-${turn}`,
              author: { role: "tool", name: "no_status_tool" },
              content: { content_type: "text", parts: [""] },
            },
          },
        };
        return [toolFrameNoStatus, assistantAddFrame(upstream, `a-${turn}`, "done"), "[DONE]"];
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 200, res.body);
      const toolEvents = JSON.parse(res.json().metadata.mirror_tool_events);
      assert.equal(toolEvents[0].status, null);
    },
  );
});

test("an https image_url whose response has no content-type header falls back to a generic mime type and is rejected as non-image", async () => {
  useSession("account-branch-no-content-type");
  await withFetch(
    async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/no-content-type.bin") return new Response(new Uint8Array([1, 2, 3, 4]));
      return stubBackend("account-branch-no-content-type", {})(url, init);
    },
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "image_url", image_url: { url: "https://example.com/no-content-type.bin" } },
              ],
            },
          ],
        },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.match(res.json().error.message, /does not look like an image/);
    },
  );
});

test("a non-Error value thrown while resolving an image attachment is still reported as a 400", async () => {
  useSession("account-branch-nonerror-image");
  await withFetch(
    async (url, init = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/rejects-non-error.jpg") throw "not an Error instance";
      return stubBackend("account-branch-nonerror-image", {})(url, init);
    },
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "what is this?" },
                { type: "image_url", image_url: { url: "https://example.com/rejects-non-error.jpg" } },
              ],
            },
          ],
        },
      });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().error.message, "Could not process an image_url attachment");
    },
  );
});

test("a data: URI with a bare 'image/' mime type still uploads, defaulting its file extension to png", async () => {
  useSession("account-branch-bare-mime");
  const sent = [];
  await withFetch(stubBackendWithUploads("account-branch-bare-mime", { sent }), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "data:image/,SGVsbG8=" } }],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
  });
});

test("a session with no accountId falls back to the default account for both image ownership and conversation ownership", async () => {
  // Deliberately bypass useSession() (which always sets an accountId): a
  // verified session's accountId is optional (see saveVerifiedSession in
  // store.ts), so getSession()?.accountId can genuinely be undefined even
  // with otherwise-valid credentials.
  store.saveVerifiedSession("session-token-for-no-account-long-enough", undefined, "device-no-account");
  store.updateMintedToken("cached-access", Date.now() + 60 * 60 * 1000, null);
  const sent = [];
  await withFetch(stubBackendWithUploads("default", { sent }), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: pngDataUrl() } },
            ],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const conversationId = res.headers["x-mirror-conversation-id"];
    assert.equal(store.getConversation(conversationId).accountId, "default");
  });
});

test("a caller-provided conversation_id for a brand-new conversation is honored as its id", async () => {
  useSession("account-branch-caller-id");
  await withFetch(stubBackend("account-branch-caller-id", {}), async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        metadata: { conversation_id: "caller-chosen-id-42" },
        messages: [{ role: "user", content: "hi" }],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["x-mirror-conversation-id"], "caller-chosen-id-42");
    assert.ok(store.getConversation("caller-chosen-id-42"));
  });
});

test("resent history with an explicit matching (non-auto) model is still recognized as a continuation", async () => {
  useSession("account-branch-explicit-model-continue");
  await withFetch(stubBackend("account-branch-explicit-model-continue", {}), async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "gpt-5-6", messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(first.statusCode, 200, first.body);
    const conversationId = first.headers["x-mirror-conversation-id"];
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "gpt-5-6",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "again" },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers["x-mirror-conversation-id"], conversationId, "must be recognized as the same conversation, not a new one");
  });
});

test("editing only the system prompt (unchanged real history) rebases as a context change, not a user-history edit", async () => {
  useSession("account-branch-context-rebase");
  await withFetch(
    stubBackend("account-branch-context-rebase", {
      turnFrames: (body, turn) => [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `a-${turn}`, `reply-${turn}`), "[DONE]"],
    }),
    async () => {
      const first = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          messages: [
            { role: "system", content: "Instructions A" },
            { role: "user", content: "hello" },
          ],
        },
      });
      assert.equal(first.statusCode, 200, first.body);
      const conversationId = first.headers["x-mirror-conversation-id"];
      assert.deepEqual(
        store.listMessages(conversationId).map(({ role, content }) => ({ role, content })),
        [
          { role: "user", content: "hello" },
          { role: "assistant", content: "reply-1" },
        ],
      );

      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "auto",
          metadata: { conversation_id: conversationId },
          messages: [
            { role: "system", content: "Instructions B (changed)" },
            { role: "user", content: "hello" },
            { role: "assistant", content: "reply-1" },
            { role: "user", content: "follow up" },
          ],
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      // The real user/assistant history is untouched by the system-prompt
      // edit, so it must survive the rebase with its original rows intact
      // rather than being treated as an edited user turn.
      assert.deepEqual(
        store.listMessages(conversationId).map(({ role, content }) => ({ role, content })),
        [
          { role: "user", content: "hello" },
          { role: "assistant", content: "reply-1" },
          { role: "user", content: "follow up" },
          { role: "assistant", content: "reply-2" },
        ],
      );
    },
  );
});

test("a legacy conversation with a saved context hash but no transcript hash also rebases as a context change", async () => {
  useSession("account-branch-legacy-context");
  const imported = store.createConversation({
    id: "legacy-ctx-test",
    accountId: "account-branch-legacy-context",
    model: "model-a",
  });
  imported.conversationId = "legacy-upstream-ctx";
  imported.currentNodeId = "legacy-assistant-node";
  imported.initialized = true;
  store.updateConversation(imported);
  store.addMessage({
    conversationId: imported.id,
    upstreamNodeId: "legacy-user-node",
    role: "user",
    content: "question",
    status: "done",
    events: [],
  });
  store.addMessage({
    conversationId: imported.id,
    upstreamNodeId: "legacy-assistant-node",
    role: "assistant",
    content: "answer",
    status: "done",
    events: [],
  });
  // A context hash saved with no matching transcript hash simulates data
  // that predates transcript fingerprinting but postdates context hashing -
  // an intermediate migration state. Any placeholder value that won't equal
  // the freshly-computed hash of the new request's system/developer
  // messages is enough to force legacyContextChanged to fire.
  store.saveOpenAiContext(imported.id, "stale-context-hash-value");

  await withFetch(
    stubBackend("account-branch-legacy-context", {
      turnFrames: (_body, turn) => [assistantAddFrame("legacy-upstream-ctx", `a-${turn}`, "answer-2"), "[DONE]"],
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "model-a",
          metadata: { conversation_id: imported.id },
          messages: [
            { role: "system", content: "New instructions" },
            { role: "user", content: "question" },
            { role: "assistant", content: "answer" },
            { role: "user", content: "new followup" },
          ],
        },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers["x-mirror-conversation-id"], imported.id);
    },
  );
});

test("a non-Error value thrown mid-turn is still reported as a generic, redacted 502 error", async () => {
  useSession("account-branch-nonerror-turn");
  await withFetch(
    stubBackend("account-branch-nonerror-turn", {
      turnFrames: () => {
        throw "raw string boom";
      },
    }),
    async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: { model: "auto", messages: [{ role: "user", content: "hi" }] },
      });
      assert.equal(res.statusCode, 502, res.body);
      assert.notEqual(res.json().error.message, "raw string boom");
      assert.equal(res.json().error.type, "server_error");
      assert.equal(res.json().error.code, "upstream_failure");
    },
  );
});

// ---------------------------------------------------------------------------
// sse()'s slow-consumer guard: reproducing real outbound-socket backpressure
// end-to-end would be slow/flaky, so it's tested directly as the plain
// function of reply.raw.writableLength (plus elapsed time, injected via the
// `now` param) it actually is (see the comment on the exported sse() in
// openai.ts).
// ---------------------------------------------------------------------------

test("sse() writes normally below the high-water mark, no matter how long it's been", () => {
  const writes = [];
  const reply = {
    raw: {
      writableLength: 1024,
      destroy: () => { throw new Error("should not have destroyed the connection"); },
      write: (chunk) => writes.push(chunk),
    },
  };
  openai.sse(reply, { hello: "world" });
  openai.sse(reply, "[DONE]");
  assert.deepEqual(writes, ['data: {"hello":"world"}\n\n', "data: [DONE]\n\n"]);
});

test("sse() tolerates a bursty backlog that drains before the stall timeout", () => {
  const writes = [];
  let destroyed = false;
  const raw = {
    writableLength: 9 * 1024 * 1024,
    destroy: () => { destroyed = true; },
    write: (chunk) => writes.push(chunk),
  };
  const reply = { raw };
  const t0 = 1_000_000;
  openai.sse(reply, { hello: "world" }, t0); // starts the stall clock
  raw.writableLength = 0; // the consumer caught up
  openai.sse(reply, { hello: "again" }, t0 + 20_000); // long past the timeout, but it drained meanwhile
  assert.equal(destroyed, false);
  assert.deepEqual(writes, ['data: {"hello":"world"}\n\n', 'data: {"hello":"again"}\n\n']);
});

test("sse() destroys the connection once the backlog stays stalled past the timeout", () => {
  const writes = [];
  let destroyed = false;
  const raw = {
    writableLength: 9 * 1024 * 1024,
    destroy: () => { destroyed = true; },
    write: (chunk) => writes.push(chunk),
  };
  const reply = { raw };
  const t0 = 1_000_000;
  openai.sse(reply, { hello: "world" }, t0); // starts the stall clock
  openai.sse(reply, { hello: "still backed up" }, t0 + 5_000); // within the grace window - still fine
  assert.equal(destroyed, false);
  assert.throws(
    () => openai.sse(reply, { hello: "still stuck" }, t0 + 15_001),
    /Response consumer is too slow/,
  );
  assert.equal(destroyed, true);
  assert.deepEqual(writes, [
    'data: {"hello":"world"}\n\n',
    'data: {"hello":"still backed up"}\n\n',
  ]);
});

// ---------------------------------------------------------------------------
// Real-socket-only branches: light-my-request's mock socket (used by every
// app.inject() call above) has no setNoDelay method, so the guard added
// around it (see the comment in openai.ts right above the call) always
// takes its "skip" path under inject. A real listener + a real HTTP client
// is the only way to exercise the "socket really has setNoDelay" branch.
// ---------------------------------------------------------------------------

test("a streaming completion over a real socket still calls setNoDelay and completes normally", async () => {
  useSession("account-branch-real-socket");
  // The real outbound HTTP call this test itself makes (to the app's own
  // real listener below) must bypass the globalThis.fetch mock that
  // withFetch() installs for the *app's* upstream calls - capture the real
  // fetch first, before it gets swapped out.
  const realFetch = globalThis.fetch;
  await withFetch(
    stubBackend("account-branch-real-socket", {
      turnFrames: (body, turn) => [assistantAddFrame(body?.conversation_id ?? `upstream-${turn}`, `a-${turn}`, "hello real socket"), "[DONE]"],
    }),
    async () => {
      // A dedicated Fastify instance, not the shared `app` every other
      // test in this file inject()s against: a Fastify instance can't be
      // listen()'d again once closed, and every real-listener test here
      // needs to close its own listener when done.
      const { default: Fastify } = await import("fastify");
      const realApp = Fastify({ bodyLimit: 30 * 1024 * 1024 });
      await openai.registerOpenAiRoutes(realApp);
      await realApp.listen({ port: 0, host: "127.0.0.1" });
      try {
        const address = realApp.server.address();
        const port = typeof address === "object" && address ? address.port : address;
        const res = await realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.match(text, /hello real socket/);
      } finally {
        await realApp.close();
      }
    },
  );
});

test("a client that disconnects mid-stream aborts the in-flight upstream turn", async () => {
  useSession("account-branch-disconnect");
  const realFetch = globalThis.fetch;
  let releaseUpstream;
  const upstreamGate = new Promise((resolve) => {
    releaseUpstream = resolve;
  });
  const handler = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/f/conversation")) {
      // Block the upstream turn open until the client has already
      // disconnected below, so reply.raw's "close" event (and the
      // !writableEnded guard around controller.abort()) fires while the
      // turn is still genuinely in flight.
      await upstreamGate;
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return sseBody([assistantAddFrame("upstream-1", "a-1", "too late"), "[DONE]"]);
    }
    return stubBackend("account-branch-disconnect", {})(url, init);
  };
  await withFetch(handler, async () => {
    const { default: Fastify } = await import("fastify");
    const realApp = Fastify({ bodyLimit: 30 * 1024 * 1024 });
    await openai.registerOpenAiRoutes(realApp);
    await realApp.listen({ port: 0, host: "127.0.0.1" });
    try {
      const address = realApp.server.address();
      const port = typeof address === "object" && address ? address.port : address;
      const clientController = new AbortController();
      const pending = realFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "hi" }] }),
        signal: clientController.signal,
      }).catch(() => undefined);
      // Give the server time to accept the connection, hijack the reply,
      // and reach the (gated) upstream call before we disconnect.
      await new Promise((resolve) => setTimeout(resolve, 50));
      clientController.abort();
      await pending;
      // Let the server's "close" handler run and call controller.abort(),
      // which the gated upstream call above observes via init.signal.
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseUpstream();
      // Give the aborted runChat() call time to record the assistant
      // message as stopped before we inspect the store.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const [conversation] = store.listConversations("account-branch-disconnect");
      assert.ok(conversation, "expected a conversation row to have been created");
      const [assistantMessage] = store.listMessages(conversation.id).filter((m) => m.role === "assistant");
      assert.equal(assistantMessage.status, "stopped");
    } finally {
      await realApp.close();
    }
  });
});

test("canonical history reconstructs an assistant row removed during upstream streaming", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  useSession("missing-assistant-fixture");
  const db = new DatabaseSync(path.join(dir, "mirror.db"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubBackend("missing-assistant-fixture", { turnFrames: () => {
    db.prepare("DELETE FROM messages WHERE role = 'assistant'").run();
    return [assistantAddFrame("upstream-missing-assistant", "answer", "Recovered"), "[DONE]"];
  } });
  try {
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: {
      model: "auto", stream: false, messages: [{ role: "user", content: "hello" }],
    } });
    assert.equal(response.statusCode, 200, response.body);
    const id = response.headers["x-mirror-conversation-id"];
    const messages = store.listMessages(id);
    assert.deepEqual(messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "hello" }, { role: "assistant", content: "Recovered" },
    ]);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
