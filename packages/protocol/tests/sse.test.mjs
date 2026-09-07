import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationStreamReducer,
  SseFrameDecoder,
  generateProofTokenInWorker,
  iterSseDataLines,
  normalizeGizmos,
  normalizeModels,
} from "../dist/index.js";

test("SSE framing preserves CRLF and arbitrary network boundaries", () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('data: "v'), []);
  assert.deepEqual(decoder.push('1"\r\n\r'), []);
  assert.deepEqual(decoder.push("\ndata: [DONE]\n\n"), [
    'data: "v1"',
    "data: [DONE]",
  ]);
  assert.deepEqual(decoder.finish(), []);
});

test("compressed append events stream text and retain the final assistant node", () => {
  const reducer = new ConversationStreamReducer();
  const payloads = [
    '"v1"',
    JSON.stringify({
      p: "",
      o: "add",
      v: {
        conversation_id: "conversation-1",
        message: {
          id: "assistant-1",
          author: { role: "assistant" },
          content: { content_type: "text", parts: [""] },
          status: "in_progress",
        },
      },
    }),
    JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "Hel" }),
    JSON.stringify({ v: "lo" }),
    JSON.stringify({
      p: "/message/status",
      o: "replace",
      v: "finished_successfully",
    }),
    JSON.stringify({
      type: "message_marker",
      message_id: "assistant-1",
      marker: "last_token",
      event: "last",
    }),
    "[DONE]",
  ];
  const deltas = [];
  for (const payload of payloads) {
    reducer.feed(payload);
    deltas.push(
      ...reducer
        .drainEvents()
        .filter((event) => event.kind === "assistant_text")
        .map((event) => event.delta),
    );
  }
  assert.equal(reducer.text, "Hello");
  assert.deepEqual(deltas, ["Hel", "lo"]);
  assert.equal(reducer.conversationIdValue, "conversation-1");
  assert.equal(reducer.currentAssistantMessageId, "assistant-1");
  assert.equal(reducer.isDone, true);
});

test("structured events preserve tools, citations and generated assets", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      type: "tool_event",
      name: "file_search",
      status: "running",
      message_id: "tool-1",
    }),
  );
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: {
        citation: true,
        file_id: "file-1",
        title: "Knowledge.pdf",
        asset_pointer: "sediment://image-1",
        content_type: "image_asset_pointer",
      },
    }),
  );
  const events = reducer.drainEvents();
  assert.ok(
    events.some(
      (event) => event.kind === "tool" && event.name === "file_search",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.kind === "citation" && event.fileId === "file-1",
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "image" && event.assetPointer === "sediment://image-1",
    ),
  );
});

test("data-line extraction ignores SSE metadata", () => {
  assert.deepEqual(
    [...iterSseDataLines("event: delta\ndata: one\nid: 3\ndata: two")],
    ["one", "two"],
  );
});

test("proof-of-work executes in a worker thread", async () => {
  const token = await generateProofTokenInWorker({
    required: true,
    seed: "test",
    difficulty: "f",
    maxAttempts: 10,
  });
  assert.match(token, /^gAAAAAB/);
});

test("required proof-of-work rejects incomplete challenges", async () => {
  await assert.rejects(
    generateProofTokenInWorker({ required: true, seed: "", difficulty: "" }),
    /Invalid required proof-of-work challenge/,
  );
});

test("dynamic discovery deduplicates models and does not expose nested GPT knowledge files", () => {
  assert.deepEqual(
    normalizeModels({
      models: [
        { slug: "model-a", title: "A" },
        { slug: "model-a", title: "A duplicate" },
      ],
    }).map((model) => model.id),
    ["model-a"],
  );
  const gpts = normalizeGizmos({
    items: [
      {
        gizmo: {
          gizmo: {
            id: "gizmo-1",
            short_url: "tuesday",
            display: { name: "Tuesday", description: "A GPT" },
          },
          files: [{ id: "file-1", name: "private.pdf" }],
          tools: [],
        },
      },
    ],
  });
  assert.deepEqual(
    gpts.map((gpt) => gpt.name),
    ["Tuesday"],
  );
});

// --- parseSseEvent branches not otherwise exercised --------------------------------

test("malformed JSON payloads become unknown/raw events", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed("not valid json{{{");
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "raw" && e.raw === "not valid json{{{"));
});

test("a JSON payload that isn't a plain object becomes unknown/raw", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed("42");
  reducer.feed("[1,2,3]");
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "raw" && e.raw === 42));
  assert.ok(events.some((e) => e.kind === "raw" && Array.isArray(e.raw)));
});

test("a plain object payload with neither type nor v becomes unknown/raw", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ nothing: "recognized" }));
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "raw" && e.raw.nothing === "recognized"));
});

test("resume_conversation_token events capture the conversation id", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ type: "resume_conversation_token", token: "tok-1", conversation_id: "conv-resumed" }));
  assert.equal(reducer.conversationIdValue, "conv-resumed");
});

// --- applyTyped branches ------------------------------------------------------------

test("message_marker with a null marker on the last event still finalizes the assistant id", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ type: "message_marker", message_id: "final-msg", event: "last" }));
  assert.equal(reducer.currentAssistantMessageId, "final-msg");
});

test("a typed event whose type merely contains 'tool' is promoted to a tool event", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ type: "some_tool_result", message_id: "m1" }));
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "tool" && e.name === "some_tool_result"));
});

test("a typed event with no recognizable tool name is preserved as raw", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ type: "title_generation", title: "New title" }));
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "raw" && e.raw.type === "title_generation"));
});

// --- setCurrentMessage branches ------------------------------------------------------

test("an assistant message with no text yet emits a message event but no assistant_text", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "a1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } } },
    }),
  );
  const events = reducer.drainEvents();
  assert.ok(events.some((e) => e.kind === "message" && e.role === "assistant"));
  assert.equal(events.some((e) => e.kind === "assistant_text"), false);
});

test("a tool-role message and a computer_output message are both recognized as tool events", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({ p: "", o: "add", v: { message: { id: "t1", author: { role: "tool" }, content: { content_type: "text", parts: [""] } } } }),
  );
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "t2", author: { role: "tool" }, content: { content_type: "computer_output" } } },
    }),
  );
  const events = reducer.drainEvents();
  assert.equal(events.filter((e) => e.kind === "tool").length, 2);
});

// --- applyOp branches -----------------------------------------------------------------

test("a single add carries conversation_id and error_code together", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ p: "", o: "add", v: { conversation_id: "conv-9", error_code: "rate_limited" } }));
  assert.equal(reducer.conversationIdValue, "conv-9");
  assert.equal(reducer.error, "rate_limited");
});

test("a batched 'patch' op applies each sub-operation and scans it for specials", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "b1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } } },
    }),
  );
  reducer.feed(
    JSON.stringify({
      o: "patch",
      v: [{ p: "/message/content/parts/0", o: "append", v: "batched" }],
    }),
  );
  assert.equal(reducer.text, "batched");
});

test("/message/id replaces the tracked assistant id", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "temp-1", author: { role: "assistant" }, content: { content_type: "text", parts: ["hi"] } } },
    }),
  );
  reducer.feed(JSON.stringify({ p: "/message/id", o: "replace", v: "real-1" }));
  assert.equal(reducer.currentAssistantMessageId, "real-1");
});

test("removing the content part clears the assistant text with an empty delta", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "r1", author: { role: "assistant" }, content: { content_type: "text", parts: ["Hello"] } } },
    }),
  );
  reducer.drainEvents();
  reducer.feed(JSON.stringify({ p: "/message/content/parts/0", o: "remove", v: null }));
  const events = reducer.drainEvents();
  const delta = events.find((e) => e.kind === "assistant_text");
  assert.equal(delta.delta, "");
  assert.equal(reducer.text, "");
});

test("replacing the content part with unrelated text reports the whole new text as the delta", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "p1", author: { role: "assistant" }, content: { content_type: "text", parts: ["Hello"] } } },
    }),
  );
  reducer.drainEvents();
  reducer.feed(JSON.stringify({ p: "/message/content/parts/0", o: "replace", v: "Goodbye" }));
  const events = reducer.drainEvents();
  const delta = events.find((e) => e.kind === "assistant_text");
  assert.equal(delta.delta, "Goodbye");
  assert.equal(reducer.text, "Goodbye");
});

test("a content-part patch is a no-op when the current message has no parts array", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(
    JSON.stringify({
      p: "",
      o: "add",
      v: { message: { id: "np1", author: { role: "assistant" }, content: { content_type: "text" } } },
    }),
  );
  reducer.drainEvents();
  reducer.feed(JSON.stringify({ p: "/message/content/parts/0", o: "append", v: "x" }));
  assert.equal(reducer.drainEvents().length, 0);
});

// --- getters --------------------------------------------------------------------------

test("the role getter reflects the current message's author role", () => {
  const reducer = new ConversationStreamReducer();
  assert.equal(reducer.role, null);
  reducer.feed(
    JSON.stringify({ p: "", o: "add", v: { message: { id: "role1", author: { role: "assistant" }, content: { content_type: "text", parts: [""] } } } }),
  );
  assert.equal(reducer.role, "assistant");
});

test("unterminated frames are returned once and numeric patch cursors survive parsing", () => {
  const decoder = new SseFrameDecoder();
  assert.deepEqual(decoder.push('data: "v1"'), []);
  assert.deepEqual(decoder.finish(), ['data: "v1"']);
  assert.deepEqual(decoder.finish(), []);
  const reducer = new ConversationStreamReducer();
  assert.equal(reducer.feed('{"p":"","o":"add","v":{},"c":7}').event.c, 7);
});

test("partial and tool messages tolerate missing authors, content, and identifiers", () => {
  for (const message of [
    {}, { author: null, content: null }, { author: { role: "tool" } },
    { author: { role: "tool" }, content: { content_type: "text" } },
    { id: "a", author: { role: "assistant" } },
    { id: "a", author: { role: "assistant" }, content: { parts: [42] } },
    { id: "a", author: { role: "assistant" }, content: { parts: ["before"] } },
  ]) {
    const reducer = new ConversationStreamReducer();
    reducer.feed(JSON.stringify({ p: "", o: "replace", v: { message } }));
    assert.equal(reducer.role, message.author?.role ?? null);
    assert.equal(reducer.status, null);
    reducer.feed('{"p":"/message/content/parts/0","o":"replace","v":"replacement"}');
    if (message.id && message.content?.parts) assert.equal(reducer.text, "replacement");
    reducer.feed('{"p":"/message/status","o":"replace","v":"finished_successfully"}');
    assert.equal(reducer.status, "finished_successfully");
    assert.ok(reducer.drainEvents().some(event => event.kind === "message"));
  }
});

test("asset and citation variants preserve labels and identifiers without inventing metadata", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({ type: "attachments", values: [
    "file-service://plain sediment://image",
    { asset_pointer: "file-service://a", name: "Named" },
    { asset_pointer: "file-service://b", content_type: "image/png" },
    { asset_pointer: "sediment://c" },
    { asset_pointer: "file-service://d", content_type: "application/pdf" },
    { citation: true, metadata: { file_id: "nested", title: "Nested" } },
    { citations: [] }, { file_citation: true, fileId: "camel", name: "Camel" },
  ] }));
  const events = reducer.drainEvents();
  assert.ok(events.some(e => e.kind === "file" && e.assetPointer === "file-service://plain"));
  assert.ok(events.some(e => e.kind === "file" && e.title === "Named"));
  assert.ok(events.some(e => e.kind === "image" && e.assetPointer === "file-service://b"));
  assert.ok(events.some(e => e.kind === "image" && e.assetPointer === "sediment://c"));
  assert.ok(events.some(e => e.kind === "citation" && e.fileId === "nested" && e.title === "Nested"));
  assert.ok(events.some(e => e.kind === "citation" && e.fileId === undefined && e.title === undefined));
  assert.ok(events.some(e => e.kind === "citation" && e.fileId === "camel"));
});

test("an unlabelled last marker establishes final continuity", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed('{"type":"message_marker","event":"last","message_id":"final"}');
  assert.equal(reducer.currentAssistantMessageId, "final");
});

test("unrelated last markers do not finalize a message and empty streams have no text", () => {
  const reducer = new ConversationStreamReducer();
  assert.equal(reducer.text, "");
  reducer.feed('{"type":"message_marker","event":"last","marker":"unrelated","message_id":"other"}');
  assert.equal(reducer.currentAssistantMessageId, null);
  reducer.feed('{"type":"message_marker","event":"last","marker":"last_token","message_id":"final"}');
  assert.equal(reducer.currentAssistantMessageId, "final");
});

test("markers without an event retain their raw metadata without finalizing continuity", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed('{"type":"message_marker","message_id":"partial"}');
  const [event] = reducer.drainEvents();
  assert.equal(event.kind, "marker");
  assert.equal(event.event, undefined);
  assert.equal(reducer.currentAssistantMessageId, null);
});
