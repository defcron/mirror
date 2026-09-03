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
