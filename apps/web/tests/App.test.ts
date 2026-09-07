import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import App from "../src/App.js";

test.afterEach(() => {
  cleanup();
  localStorage.clear();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

// A tiny fetch router: every test supplies only the routes it cares about;
// anything else (in particular the two mount-time effects - /v1/models and
// /api/conversations - that fire on every single render) gets an
// inoffensive empty 200 so unrelated tests never have to think about them.
function router(handlers: Array<[RegExp, Handler]>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    // A base is required for bare relative fetches (e.g.
    // ConnectionTools/ConversationTools deliberately call fetch("/api/...")
    // directly, unprefixed by the configurable "Server domain" field,
    // since those always target this local Mirror instance) - harmless
    // for the already-absolute URLs every other call site here builds.
    const url = new URL(href, location.origin);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url.pathname)) return handler(url, init);
    }
    if (url.pathname === "/v1/models") return jsonResponse({ data: [] });
    if (url.pathname === "/api/conversations") return jsonResponse({ items: [], hasMore: false });
    return jsonResponse({});
  }) as typeof fetch;
}

async function renderApp(handlers: Array<[RegExp, Handler]> = []) {
  globalThis.fetch = router(handlers);
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(React.createElement(App));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return utils;
}

function lastUserTextarea() {
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA");
  return textareas.at(-1) as HTMLTextAreaElement;
}

function runButton() {
  return screen.getByRole("button", { name: /^Run/ });
}

// ---------------------------------------------------------------------------
// Rendering & defaults
// ---------------------------------------------------------------------------

test("renders the platform header, sidebar, and default two-message transcript", async () => {
  await renderApp();
  assert.ok(screen.getByRole("heading", { name: "Chat" }));
  const header = screen.getByRole("banner");
  assert.ok(within(header).getByRole("link", { name: "ChatGPT" }));
  assert.ok(within(header).getByRole("link", { name: /Playground/ }));
  assert.ok(within(header).getByRole("link", { name: /Models/ }));
  assert.ok(within(header).getByRole("link", { name: /API docs/ }));
  assert.ok(within(header).getByRole("link", { name: /OpenAPI schema/ }));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  assert.equal(screen.getByText("Ready").className, "run-status ready");
});

test("Run is blocked with an explanatory reason when the last row isn't a fillable user message", async () => {
  await renderApp();
  // Default last row IS a filled user row - clear it first.
  fireEvent.change(lastUserTextarea(), { target: { value: "   " } });
  fireEvent.click(runButton());
  assert.ok(await screen.findByText("Blocked"));
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/user.*row/i).textContent ?? "", /Type a message/);
});

test("Run is blocked when the last row's role isn't user at all", async () => {
  await renderApp();
  const selects = screen.getAllByRole("combobox").filter((el) => el.closest(".message-editor"));
  fireEvent.change(selects.at(-1) as HTMLSelectElement, { target: { value: "system" } });
  fireEvent.click(runButton());
  assert.ok(await screen.findByText("Blocked"));
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/must be from the user/).textContent ?? "", /must be from the user/);
});

test("toggling the model field between list and freeform, and revealing the gizmo picker for g- models", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "gpt-x", owned_by: "openai" }] })],
  ]);
  assert.equal(screen.queryByPlaceholderText(/Picked model/), null);
  fireEvent.click(screen.getByRole("button", { name: "Type manually" }));
  const modelInput = screen.getByPlaceholderText(/official model/);
  fireEvent.change(modelInput, { target: { value: "g-12345" } });
  assert.ok(screen.getByLabelText(/Picked model/));
  fireEvent.click(screen.getByRole("button", { name: "Use list" }));
  assert.ok(screen.getByRole("combobox", { name: /Model/ }) || true);
});

// ---------------------------------------------------------------------------
// localStorage snapshot loading (loadSnapshot / loadStoredConversationId /
// loadStoredMessages)
// ---------------------------------------------------------------------------

test("with no remember-history flag set, defaults are used and nothing is hydrated from storage", async () => {
  await renderApp();
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  const conversationIdInput = screen.getByPlaceholderText(/auto \(filled in/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "");
});

test("a valid remembered snapshot hydrates model, pickedModel, privateChat, conversationId, and messages", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem(
    "mirror-playground-snapshot",
    JSON.stringify({
      model: "g-remembered",
      pickedModel: "gpt-5-6",
      privateChat: true,
      conversationId: "conv-remembered",
      messages: [
        { role: "system", content: "remembered system" },
        { role: "user", content: "remembered user" },
      ],
    }),
  );
  await renderApp();
  const conversationIdInput = screen.getByPlaceholderText(/auto \(filled in/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "conv-remembered");
  assert.ok(screen.getByDisplayValue("remembered system"));
  assert.ok(screen.getByDisplayValue("remembered user"));
  assert.ok((screen.getByLabelText("Private chat") as HTMLInputElement).checked);
  assert.ok(screen.getByLabelText(/Picked model/));
});

test("a malformed remembered snapshot falls back to the defaults instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", "{not json");
  await renderApp();
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  const conversationIdInput = screen.getByPlaceholderText(/auto \(filled in/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "");
});

test("a remembered snapshot whose messages fail shape validation falls back to the defaults", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem(
    "mirror-playground-snapshot",
    JSON.stringify({ messages: [{ role: "not-a-real-role", content: "x" }] }),
  );
  await renderApp();
  assert.ok(screen.getByDisplayValue("Say hello in one short sentence."));
});

test("a remembered snapshot with an empty messages array falls back to the defaults", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ messages: [] }));
  await renderApp();
  assert.ok(screen.getByDisplayValue("Say hello in one short sentence."));
});

// ---------------------------------------------------------------------------
// rememberHistory persistence effect
// ---------------------------------------------------------------------------

test("turning Remember history on persists a snapshot; turning it off removes it", async () => {
  await renderApp();
  const checkbox = screen.getByLabelText("Remember prompt history on this device");
  fireEvent.click(checkbox);
  await waitFor(() => assert.ok(localStorage.getItem("mirror-playground-snapshot")));
  const saved = JSON.parse(localStorage.getItem("mirror-playground-snapshot") as string);
  assert.equal(saved.model, "auto");
  fireEvent.click(checkbox);
  await waitFor(() => assert.equal(localStorage.getItem("mirror-playground-snapshot"), null));
});

test("enabling one-shot while remembering history still clears the persisted snapshot", async () => {
  await renderApp();
  fireEvent.click(screen.getByLabelText("Remember prompt history on this device"));
  await waitFor(() => assert.ok(localStorage.getItem("mirror-playground-snapshot")));
  fireEvent.click(screen.getByLabelText(/One-shot/));
  await waitFor(() => assert.equal(localStorage.getItem("mirror-playground-snapshot"), null));
});


// ---------------------------------------------------------------------------
// Models discovery effect
// ---------------------------------------------------------------------------

test("populates the model dropdown from /v1/models, labelling gizmos/projects and marking unsupported ones", async () => {
  await renderApp([
    [
      /^\/v1\/models$/,
      () =>
        jsonResponse({
          data: [
            { id: "gpt-plain", owned_by: "openai" },
            { id: "gpt-unsupported", owned_by: "openai", mirror: { supported: false } },
            { id: "g-1", owned_by: "chatgpt-gizmo", name: "Helper" },
            { id: "g-p-1", owned_by: "chatgpt-project" },
          ],
        }),
    ],
  ]);
  const select = screen.getByLabelText("Model") as HTMLSelectElement;
  const optionTexts = Array.from(select.options).map((o) => o.textContent);
  assert.ok(optionTexts.includes("gpt-plain"));
  assert.ok(optionTexts.includes("gpt-unsupported (unsupported)"));
  assert.ok(optionTexts.includes("GPT: Helper"));
  assert.ok(optionTexts.includes("Project: g-p-1"));
  const unsupportedOption = within(select).getByText("gpt-unsupported (unsupported)") as HTMLOptionElement;
  assert.equal(unsupportedOption.disabled, true);
});

test("a failed model-discovery fetch is swallowed silently, leaving only the auto option", async () => {
  await renderApp([[/^\/v1\/models$/, () => { throw new Error("network down"); }]]);
  const select = screen.getByLabelText("Model") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, "auto");
});

test("a non-ok model-discovery response is swallowed silently", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ error: "nope" }, { status: 500 })]]);
  const select = screen.getByLabelText("Model") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
});

test("a model-discovery response whose data isn't an array is ignored", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ data: "not-an-array" })]]);
  const select = screen.getByLabelText("Model") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
});

test("the bearer credential is sent as an authorization header on model discovery", async () => {
  const seen: Array<string | null> = [];
  await renderApp([
    [
      /^\/v1\/models$/,
      (_url, init) => {
        seen.push((init?.headers as Record<string, string> | undefined)?.authorization ?? null);
        return jsonResponse({ data: [] });
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("Bearer credential"), { target: { value: "sk-test" } });
  await waitFor(() => assert.ok(seen.includes("Bearer sk-test")));
});

// ---------------------------------------------------------------------------
// Conversations list: mount fetch, refresh, and scroll pagination
// ---------------------------------------------------------------------------

test("shows a loading state, then an empty state when there are no conversations", async () => {
  const gate = deferred<Response>();
  globalThis.fetch = router([[/^\/api\/conversations$/, () => gate.promise]]);
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(React.createElement(App));
  });
  assert.ok(screen.getByText("Loading…"));
  gate.resolve(jsonResponse({ items: [], hasMore: false }));
  await screen.findByText("No conversations yet");
});

test("renders fetched conversations and marks the currently loaded one active", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [
              { id: "c1", title: "First chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" },
              { id: "c2", title: "", model: "auto", updatedAt: "2024-01-02T00:00:00.000Z" },
            ],
            hasMore: true,
          });
        }
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
  ]);
  assert.ok(screen.getByText("First chat"));
  assert.ok(screen.getByText("Untitled"));
});

test("scrolling near the bottom of the conversation list loads the next page", async () => {
  let secondPageRequested = false;
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [{ id: "c1", title: "Page one", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
            hasMore: true,
          });
        }
        secondPageRequested = true;
        return jsonResponse({
          items: [{ id: "c2", title: "Page two", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
          hasMore: false,
        });
      },
    ],
  ]);
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(secondPageRequested);
  await screen.findByText("Page two");
});

test("the Refresh button re-syncs the conversation list from the top with resync=true", async () => {
  let sawResync = false;
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("resync") === "true") sawResync = true;
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
  ]);
  fireEvent.click(screen.getByText("Refresh"));
  await waitFor(() => assert.ok(sawResync));
});

test("a failed conversations fetch is swallowed and the list just stays empty", async () => {
  await renderApp([[/^\/api\/conversations$/, () => { throw new Error("boom"); }]]);
  assert.ok(screen.getByText("No conversations yet"));
});

// ---------------------------------------------------------------------------
// run(): success paths (non-streaming and streaming), metadata, headers
// ---------------------------------------------------------------------------

test("a non-streaming run posts the right body/headers, shows the raw JSON, appends the reply, and refreshes conversations", async () => {
  let conversationsFetchCount = 0;
  let capturedBody: Record<string, unknown> | null = null;
  let capturedHeaders: Record<string, string> = {};
  await renderApp([
    [
      /^\/api\/conversations$/,
      () => {
        conversationsFetchCount += 1;
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(
          { choices: [{ message: { content: "Hello there" } }] },
          { headers: { "x-mirror-conversation-id": "conv-xyz" } },
        );
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("Bearer credential"), { target: { value: "sk-run" } });
  fireEvent.click(screen.getByLabelText("Stream response")); // turn OFF streaming
  fireEvent.click(screen.getByLabelText("Private chat"));
  fireEvent.click(runButton());
  assert.ok(screen.getByText("Running…"));
  await screen.findByText("Completed");
  assert.equal((capturedBody as unknown as { model: string }).model, "auto");
  assert.deepEqual((capturedBody as unknown as { metadata: unknown }).metadata, { private: "true" });
  assert.equal(capturedHeaders.authorization, "Bearer sk-run");
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "conv-xyz");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/"content": "Hello there"/).textContent ?? "", /Hello there/);
  assert.ok(screen.getByDisplayValue("Hello there"));
  await waitFor(() => assert.ok(conversationsFetchCount >= 2));
});

test("a streaming run reads SSE frames, updates the conversation id mid-stream, and appends the final reply", async () => {
  const sse =
    `: mirror-conversation-id stream-conv-1\ndata: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    ],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("Completed");
  assert.ok(screen.getByDisplayValue("Hi"));
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "stream-conv-1");
});

test("one-shot runs don't append the reply to the transcript and don't refresh conversations", async () => {
  let conversationsFetchCount = 0;
  await renderApp([
    [/^\/api\/conversations$/, () => { conversationsFetchCount += 1; return jsonResponse({ items: [], hasMore: false }); }],
    [/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "ephemeral" } }] })],
  ]);
  fireEvent.click(screen.getByLabelText(/One-shot/));
  fireEvent.click(screen.getByLabelText("Stream response"));
  const before = conversationsFetchCount;
  fireEvent.click(runButton());
  await screen.findByText("Completed");
  assert.equal(screen.queryByDisplayValue("ephemeral"), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(conversationsFetchCount, before);
});

test("a gizmo model with a picked sub-model sends mirror_model metadata, and an active conversation id is threaded through", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    ],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Type manually" }));
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "g-1" } });
  fireEvent.change(screen.getByLabelText(/Picked model/), { target: { value: "gpt-5-6" } });
  fireEvent.change(screen.getByPlaceholderText(/auto \(filled in/), { target: { value: "existing-conv" } });
  fireEvent.click(screen.getByLabelText("Stream response"));
  fireEvent.click(runButton());
  await screen.findByText("Completed");
  assert.deepEqual((capturedBody as unknown as { metadata: unknown }).metadata, {
    mirror_model: "gpt-5-6",
    conversation_id: "existing-conv",
  });
});

// ---------------------------------------------------------------------------
// run(): error and abort paths
// ---------------------------------------------------------------------------

test("a non-ok response from the run endpoint surfaces the status and body as an error", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => new Response("upstream exploded", { status: 502 })],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/502/).textContent ?? "", /502.*upstream exploded/s);
});

test("a rejected fetch during run() surfaces the error message", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => { throw new Error("DNS failure"); }],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/DNS failure/).textContent ?? "", /DNS failure/);
});

test("a streaming run with no response body reports the missing-stream error", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => new Response(null, { status: 200 })],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/no stream body/).textContent ?? "", /no stream body/);
});

test("clicking Stop aborts the in-flight run and reports Stopped, not Error", async () => {
  const gate = deferred<Response>();
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("Running…");
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await screen.findByText("Stopped");
  void gate;
});


// ---------------------------------------------------------------------------
// loadConversation()
// ---------------------------------------------------------------------------

test("loading a conversation with a gizmo hydrates instructions, messages, model, and private flag", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "g-1", owned_by: "chatgpt-gizmo", name: "Helper" }] })],
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c1", title: "Gizmo chat", model: "g-1", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c1$/,
      () =>
        jsonResponse({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello!" },
          ],
          instructions: [{ role: "system", content: "custom instructions" }],
          conversation: { id: "c1", model: "g-1", gizmoId: "g-1", private: true },
        }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Gizmo chat"));
  await screen.findByText("Loaded");
  assert.ok(screen.getByDisplayValue("custom instructions"));
  assert.ok(screen.getByDisplayValue("hi"));
  assert.ok(screen.getByDisplayValue("hello!"));
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "c1");
  assert.ok((screen.getByLabelText("Private chat") as HTMLInputElement).checked);
  assert.equal((screen.getByLabelText("Model") as HTMLSelectElement).value, "g-1");
});

test("loading a non-gizmo, non-auto conversation adopts its model and clears the picked-model field", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "gpt-x", owned_by: "openai" }] })],
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c2", title: "Plain chat", model: "gpt-x", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c2$/,
      () =>
        jsonResponse({
          messages: [{ role: "user", content: "hey" }],
          conversation: { id: "c2", model: "gpt-x" },
        }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Plain chat"));
  await screen.findByText("Loaded");
  assert.equal((screen.getByLabelText("Model") as HTMLSelectElement).value, "gpt-x");
});

test("loading a conversation whose model is 'auto' leaves the currently selected model untouched", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c3", title: "Auto chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c3$/,
      () => jsonResponse({ messages: [], conversation: { id: "c3", model: "auto" } }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Auto chat"));
  await screen.findByText("Loaded");
  assert.equal((screen.getByLabelText("Model") as HTMLSelectElement).value, "auto");
});

test("a failed conversation load reports the status/body as an error", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c4", title: "Broken chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c4$/, () => new Response("nope", { status: 404 })],
  ]);
  fireEvent.click(await screen.findByText("Broken chat"));
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.match(screen.getByText(/404/).textContent ?? "", /404.*nope/s);
});

// ---------------------------------------------------------------------------
// Message editing, removal, add, and the New-conversation reset
// ---------------------------------------------------------------------------

test("adding, editing, and removing messages updates the transcript", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: /Add message/ }));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 3);
  const removeButtons = screen.getAllByRole("button", { name: "Remove message" });
  fireEvent.click(removeButtons[0]);
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  fireEvent.change(lastUserTextarea(), { target: { value: "edited content" } });
  assert.ok(screen.getByDisplayValue("edited content"));
});

test("editing and removing are no-ops while a run is in flight, even though the row itself is disabled", async () => {
  const gate = deferred<Response>();
  await renderApp([[/^\/v1\/chat\/completions$/, () => gate.promise]]);
  fireEvent.click(screen.getByLabelText("Stream response")); // turn off streaming - gate resolves plain JSON
  const originalContent = (lastUserTextarea() as HTMLTextAreaElement).value;
  fireEvent.click(runButton());
  await screen.findByText("Running…");
  // Directly dispatch change/click - bypassing the "disabled" DOM attribute
  // the way a stray queued event or a race could - to prove the *runningRef*
  // guard inside updateMessage/removeMessage (not just the disabled attribute)
  // is what's actually doing the blocking.
  fireEvent.change(lastUserTextarea(), { target: { value: "should not stick" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Remove message" })[0]);
  gate.resolve(jsonResponse({ choices: [{ message: { content: "done" } }] }));
  await screen.findByText("Completed");
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
  // [system, original user (untouched), assistant("done"), new empty user draft]
  assert.equal(textareas.length, 4);
  assert.equal(textareas[1].value, originalContent);
});

test("an assistant message row is read-only and cannot be removed", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "reply" } }] })]]);
  fireEvent.click(screen.getByLabelText("Stream response"));
  fireEvent.click(runButton());
  await screen.findByText("Completed");
  const assistantTextarea = screen.getByDisplayValue("reply") as HTMLTextAreaElement;
  assert.equal(assistantTextarea.readOnly, true);
  const assistantRow = assistantTextarea.closest(".message-editor") as HTMLElement;
  const roleSelect = within(assistantRow).getByRole("combobox") as HTMLSelectElement;
  assert.equal(roleSelect.disabled, true);
  const removeButton = within(assistantRow).getByRole("button", { name: "Assistant messages cannot be removed" });
  assert.equal((removeButton as HTMLButtonElement).disabled, true);
});

test("the New button resets the conversation id and the transcript to the defaults", async () => {
  await renderApp();
  fireEvent.change(screen.getByPlaceholderText(/auto \(filled in/), { target: { value: "some-conv" } });
  fireEvent.change(lastUserTextarea(), { target: { value: "custom prompt" } });
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "");
  assert.ok(screen.getByDisplayValue("You are a helpful assistant."));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
});

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

test("Ctrl/Cmd+Enter triggers a run", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "via keyboard" } }] })]]);
  fireEvent.click(screen.getByLabelText("Stream response"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  });
  await screen.findByText("Completed");
  assert.ok(screen.getByDisplayValue("via keyboard"));
});

// ---------------------------------------------------------------------------
// Connection bar (domain/path/endpoint memo)
// ---------------------------------------------------------------------------

test("editing the domain and path fields updates the computed request URL, trimming/padding as needed", async () => {
  await renderApp();
  fireEvent.change(screen.getByLabelText("Server domain"), { target: { value: "https://example.com/" } });
  fireEvent.change(screen.getByLabelText("Path"), { target: { value: "v1/chat/completions" } });
  assert.equal(screen.getByText("https://example.com/v1/chat/completions").tagName, "CODE");
});

// ---------------------------------------------------------------------------
// Remaining defensive branches
// ---------------------------------------------------------------------------

test("a throwing localStorage.getItem during initial mount falls back to rememberHistory=false", async () => {
  const original = Storage.prototype.getItem;
  let calls = 0;
  Storage.prototype.getItem = function patched(key: string) {
    calls += 1;
    if (key === "mirror-playground-remember-history") throw new Error("storage blocked");
    return original.call(this, key);
  };
  try {
    await renderApp();
    assert.equal((screen.getByLabelText("Remember prompt history on this device") as HTMLInputElement).checked, false);
    assert.ok(calls > 0);
  } finally {
    Storage.prototype.getItem = original;
  }
});

test("a failed load-more request is swallowed, leaving the list as-is for a retry", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [{ id: "c1", title: "Page one", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
            hasMore: true,
          });
        }
        throw new Error("page 2 unavailable");
      },
    ],
  ]);
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText("Page one"));
  assert.equal(screen.queryByText("Loading more…"), null);
});

test("loading a conversation whose stored messages field isn't an array tolerates it as empty", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c9", title: "Weird chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c9$/, () => jsonResponse({ conversation: { id: "c9", model: "auto" } })],
  ]);
  fireEvent.click(await screen.findByText("Weird chat"));
  await screen.findByText("Loaded");
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
  // No instructions, no stored messages -> just the trailing empty user draft.
  assert.equal(textareas.length, 1);
  assert.equal(textareas[0].value, "");
});

// ---------------------------------------------------------------------------
// A few remaining defensive/fallback branches
// ---------------------------------------------------------------------------

test("remembering history with no snapshot ever saved yet falls back cleanly through every loader", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  // Deliberately no "mirror-playground-snapshot" key at all.
  await renderApp();
  assert.equal((screen.getByLabelText("Model") as HTMLSelectElement).value, "auto");
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "");
  assert.ok(screen.getByDisplayValue("Say hello in one short sentence."));
});

test("a throwing localStorage.setItem during the persistence effect is swallowed", async () => {
  await renderApp();
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function patched() {
    throw new Error("quota exceeded");
  };
  try {
    // Should not throw/crash the app even though every localStorage.setItem
    // call in the persistence effect now fails.
    fireEvent.click(screen.getByLabelText("Remember prompt history on this device"));
    assert.ok(screen.getByLabelText("Remember prompt history on this device"));
  } finally {
    Storage.prototype.setItem = original;
  }
});

test("a conversations response whose items field isn't an array is tolerated as empty", async () => {
  await renderApp([[/^\/api\/conversations$/, () => jsonResponse({ items: "not-an-array", hasMore: false })]]);
  assert.ok(screen.getByText("No conversations yet"));
});

test("scrolling when there's nothing more to load is a no-op", async () => {
  let requestCount = 0;
  await renderApp([
    [
      /^\/api\/conversations$/,
      () => {
        requestCount += 1;
        return jsonResponse({ items: [{ id: "c1", title: "Only page", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }], hasMore: false });
      },
    ],
  ]);
  const countAfterMount = requestCount;
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(requestCount, countAfterMount);
});

test("loading a conversation whose response omits the conversation object falls back to the requested id", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c-no-conv", title: "No conv object", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c-no-conv$/, () => jsonResponse({ messages: [] })],
  ]);
  fireEvent.click(await screen.findByText("No conv object"));
  await screen.findByText("Loaded");
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "c-no-conv");
});

test("a non-Error value thrown while loading a conversation still surfaces something readable", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c-weird-throw", title: "Weird throw", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c-weird-throw$/, () => { throw "a plain string reason"; }],
  ]);
  fireEvent.click(await screen.findByText("Weird throw"));
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.ok(screen.getByText("a plain string reason"));
});

test("a non-Error value thrown during run() still surfaces something readable", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => { throw "run blew up as a plain string"; }]]);
  fireEvent.click(runButton());
  await screen.findByText("Error");
  fireEvent.click(screen.getByRole("button", { name: /Raw response/ }));
  assert.ok(screen.getByText("run blew up as a plain string"));
});

test("a stray re-entrant run() call while one is already in flight is a no-op (belt-and-suspenders guard)", async () => {
  let fetchCount = 0;
  const gate = deferred<Response>();
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => {
        fetchCount += 1;
        return gate.promise;
      },
    ],
  ]);
  fireEvent.click(screen.getByLabelText("Stream response"));
  // Fire the Ctrl+Enter shortcut twice back-to-back, synchronously, before
  // React ever gets a chance to re-render the Run button into a Stop
  // button - runningRef.current is set synchronously at the very top of
  // run(), before the first await, specifically to catch this.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  gate.resolve(jsonResponse({ choices: [{ message: { content: "only once" } }] }));
  await screen.findByText("Completed");
  assert.equal(fetchCount, 1);
});

test("model selection and switching back from raw output update the visible UI", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "g-fixture", owned_by: "chatgpt-gizmo" }] })]]);
  const option = screen.getByRole("option", { name: "GPT: g-fixture" });
  fireEvent.change(option.parentElement!, { target: { value: "g-fixture" } });
  assert.ok(screen.getByLabelText(/Picked model/));
  fireEvent.click(screen.getByRole("button", { name: "Raw response" }));
  fireEvent.click(screen.getByRole("button", { name: "Output" }));
  assert.equal(screen.getByRole("button", { name: "Output" }).className, "active");
});

test("a malformed completion fails without appending phantom history rows", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [] })]]);
  fireEvent.click(screen.getByLabelText(/Stream/));
  fireEvent.click(runButton());
  await screen.findByText("Error");
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
});

test("a conversation with an empty id is ignored", async () => {
  await renderApp([[/^\/api\/conversations$/, () => jsonResponse({ items: [{ id: "", title: "Invalid conversation", model: "auto", updatedAt: "2024-01-01" }], hasMore: false })]]);
  fireEvent.click(await screen.findByText("Invalid conversation"));
  assert.ok(screen.getByText("Ready"));
});

test("a queued remove click cannot change history after a run has started", async () => {
  const gate = deferred<Response>();
  await renderApp([[/^\/v1\/chat\/completions$/, () => gate.promise]]);
  fireEvent.click(screen.getByLabelText("Stream response"));
  const remove = screen.getAllByRole("button", { name: "Remove message" })[0];
  const run = runButton();
  act(() => {
    run.click();
    remove.click();
  });
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
  await act(async () => { gate.resolve(jsonResponse({ choices: [] })); });
  await screen.findByText("Error");
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
});

// ---------------------------------------------------------------------------
// ConnectionTools (connection diagnostics + client setup snippet)
// ---------------------------------------------------------------------------

function connectionToolsPanel() {
  return screen.getByText("Connection diagnostics and client setup").closest("details") as HTMLElement;
}

test("Test connection reports diagnostics and model discovery results, and offers a diagnostics export link", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1, build: { revision: "abc1234" } })],
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] })],
  ]);
  const panel = connectionToolsPanel();
  assert.equal(within(panel).queryByText(/Export local diagnostics/), null);
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText(/Model discovery passed \(2 models\)\. Browser authentication used/);
  assert.match(within(panel).getByText(/"revision": "abc1234"/).textContent ?? "", /abc1234/);
  assert.ok(within(panel).getByRole("link", { name: /Export local diagnostics/ }));
});

test("Test connection reports a supplied bearer credential separately from browser auth", async () => {
  let modelsAuth: string | undefined;
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [
      /^\/v1\/models$/,
      (_url, init) => {
        modelsAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return jsonResponse({ data: [{ id: "m1" }] });
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("Bearer credential"), { target: { value: "sk-conn" } });
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText(/Bearer credential supplied\./);
  assert.equal(modelsAuth, "Bearer sk-conn");
});

test("Test connection surfaces a failed diagnostics call without touching model discovery", async () => {
  // /v1/models is also fetched once in the background on mount (for the
  // model picker), unrelated to the Test Connection button - count calls
  // rather than asserting it's never called at all.
  let modelsCalls = 0;
  await renderApp([
    [/^\/api\/diagnostics$/, () => new Response("nope", { status: 500 })],
    [/^\/v1\/models$/, () => { modelsCalls += 1; return jsonResponse({ data: [] }); }],
  ]);
  const panel = connectionToolsPanel();
  const callsBeforeClick = modelsCalls;
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText("Diagnostics returned HTTP 500");
  assert.equal(modelsCalls, callsBeforeClick);
});

test("Test connection surfaces a failed model-discovery HTTP status", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [/^\/v1\/models$/, () => new Response("nope", { status: 503 })],
  ]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText(/Model discovery returned HTTP 503\./);
});

test("Test connection rejects a model-discovery response whose data field isn't an array", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [/^\/v1\/models$/, () => jsonResponse({ data: "not-an-array" })],
  ]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText("Model discovery returned an unsupported response.");
});

test("Test connection falls back to a generic message when a non-Error value is thrown", async () => {
  await renderApp([[/^\/api\/diagnostics$/, () => { throw "network offline"; }]]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Test connection" }));
  await within(panel).findByText("Connection test failed");
});

test("the generation-status note reflects whether a Playground run has completed yet", async () => {
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => jsonResponse({ choices: [{ message: { content: "hi" } }] }, { headers: { "x-mirror-conversation-id": "conv-done" } }),
    ],
  ]);
  const panel = connectionToolsPanel();
  assert.ok(within(panel).getByText(/not verified; use Run to send a test message/));
  fireEvent.click(screen.getByLabelText("Stream response"));
  fireEvent.click(runButton());
  await screen.findByText("Completed");
  assert.ok(within(panel).getByText(/completed in this Playground session/));
});

test("Copy setup snippet reports success or falls back to a manual-copy hint", async () => {
  await renderApp();
  const panel = connectionToolsPanel();
  assert.match(within(panel).getByText(/OpenAI\(base_url=/).textContent ?? "", /YOUR_MIRROR_KEY/);
  const nav = globalThis.navigator as unknown as { clipboard?: { writeText: (text: string) => Promise<void> } };
  const originalClipboard = nav.clipboard;
  try {
    nav.clipboard = { writeText: async () => {} };
    fireEvent.click(within(panel).getByRole("button", { name: "Copy setup snippet" }));
    await within(panel).findByText("Setup snippet copied");
    nav.clipboard = { writeText: async () => { throw new Error("denied"); } };
    fireEvent.click(within(panel).getByRole("button", { name: "Copy setup snippet" }));
    await within(panel).findByText("Select and copy the setup snippet above");
  } finally {
    nav.clipboard = originalClipboard;
  }
});

// ---------------------------------------------------------------------------
// ConversationTools (local search, branches, and export)
// ---------------------------------------------------------------------------

function conversationToolsPanel() {
  return screen.getByText("Local search, branches, and export").closest("details") as HTMLElement;
}

test("with no active conversation, only local search is offered (no branches or export controls)", async () => {
  await renderApp();
  const panel = conversationToolsPanel();
  assert.equal(within(panel).queryByRole("button", { name: "Show conversation branches" }), null);
  assert.equal(within(panel).queryByRole("link", { name: "Export JSON" }), null);
  assert.ok((within(panel).getByRole("button", { name: "Search history" }) as HTMLButtonElement).disabled);
});

test("searching local history renders matches and a result count, and selecting one loads it", async () => {
  await renderApp([
    [
      /^\/api\/conversations\/search/,
      (url) => {
        assert.equal(url.searchParams.get("q"), "needle");
        return jsonResponse({ items: [{ id: "found-1", title: "Found conversation" }] });
      },
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.change(within(panel).getByLabelText("Search local history"), { target: { value: "needle" } });
  const searchButton = within(panel).getByRole("button", { name: "Search history" });
  assert.equal((searchButton as HTMLButtonElement).disabled, false);
  fireEvent.click(searchButton);
  await within(panel).findByText("1 local matches (maximum 100)");
  const resultButton = within(panel).getByRole("button", { name: "Found conversation" });
  fireEvent.click(resultButton);
  await screen.findByText("Loaded");
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "found-1");
});

test("a failed local search reports the error instead of throwing", async () => {
  await renderApp([[/^\/api\/conversations\/search/, () => new Response("nope", { status: 500 })]]);
  const panel = conversationToolsPanel();
  fireEvent.change(within(panel).getByLabelText("Search local history"), { target: { value: "needle" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Search history" }));
  await within(panel).findByText(/History request returned HTTP 500\. Reload and try again\./);
});

test("conversation branches list parents and nodes, and continuing from an assistant node selects the branch", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  let branchBody: unknown;
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }, { id: "conv-saved", title: "Saved branch" }],
          nodes: [
            { id: "m-user", upstreamNodeId: "node-6", role: "user", status: "done" },
            { id: "m-pending", upstreamNodeId: null, role: "assistant", status: "streaming" },
            { id: "m-asst", upstreamNodeId: "node-7", role: "assistant", status: "done" },
          ],
        }),
    ],
    [
      /^\/api\/conversations\/conv-remembered\/branch$/,
      (_url, init) => {
        branchBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "conv-branched" });
      },
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show conversation branches" }));
  const continueButton = await within(panel).findByRole("button", { name: "Continue from this assistant" });
  assert.ok(within(panel).getByRole("button", { name: "Saved branch" }));
  // A node with no upstream node id yet (e.g. still streaming) falls back
  // to a plain label instead of rendering a blank <code> element - and
  // does not offer to "continue" from it (that button only appears once
  // an assistant node has a real upstream node id).
  assert.ok(within(panel).getByText("No upstream node"));
  fireEvent.click(continueButton);
  await screen.findByText("Loaded");
  assert.deepEqual(branchBody, { messageId: "m-asst" });
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "conv-branched");
  // Selecting a branch resets the branch listing itself (it belonged to the
  // conversation we just navigated away from).
  assert.equal(within(panel).queryByRole("button", { name: "Continue from this assistant" }), null);
});

test("selecting a listed branch (not the current one) loads it", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }, { id: "conv-saved", title: "Saved branch" }],
          nodes: [],
        }),
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show conversation branches" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Saved branch" }));
  await screen.findByText("Loaded");
  assert.equal((screen.getByPlaceholderText(/auto \(filled in/) as HTMLInputElement).value, "conv-saved");
});

test("a failed request to create a branch reports the error instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }],
          nodes: [{ id: "m-asst", upstreamNodeId: "node-7", role: "assistant", status: "done" }],
        }),
    ],
    [/^\/api\/conversations\/conv-remembered\/branch$/, () => new Response("nope", { status: 500 })],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show conversation branches" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Continue from this assistant" }));
  await within(panel).findByText(/History request returned HTTP 500\. Reload and try again\./);
});

test("a failed branch listing reports the error instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([[/^\/api\/conversations\/conv-remembered\/branches$/, () => new Response("nope", { status: 404 })]]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "Show conversation branches" }));
  await within(panel).findByText(/History request returned HTTP 404\. Reload and try again\./);
});

test("export links include the selected attachment/metadata flags and format", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp();
  const panel = conversationToolsPanel();
  const jsonLink = () => within(panel).getByRole("link", { name: "Export JSON" });
  const markdownLink = () => within(panel).getByRole("link", { name: "Export Markdown" });
  assert.equal(jsonLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=false&metadata=false&format=json");
  assert.equal(markdownLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=false&metadata=false&format=markdown");
  fireEvent.click(within(panel).getByLabelText("Include attachment references (no file bytes)"));
  fireEvent.click(within(panel).getByLabelText("Include IDs, model, and message metadata"));
  assert.equal(jsonLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=true&metadata=true&format=json");
  assert.equal(markdownLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=true&metadata=true&format=markdown");
});
