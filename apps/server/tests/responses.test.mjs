import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stubBackend } from "./helpers/backend.mjs";
const dir = mkdtempSync(path.join(tmpdir(), "mirror-responses-"));
process.env.MIRROR_DATA_DIR = dir;
delete process.env.MIRROR_STORE_KEY;
const { default: Fastify } = await import("fastify");
const store = await import("../dist/store.js");
const { registerOpenAiRoutes } = await import("../dist/openai.js");
const app = Fastify();
await registerOpenAiRoutes(app);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const localFetch = globalThis.fetch;
test.after(async () => { globalThis.fetch = localFetch; await app.close(); rmSync(dir, { recursive: true, force: true }); });
function setup(account, options = {}) {
  store.saveVerifiedSession("synthetic-session-fixture", account, "synthetic-device");
  store.updateMintedToken("synthetic-access-fixture", Date.now() + 3_600_000, null);
  globalThis.fetch = stubBackend(account, options);
}
async function post(body) {
  return localFetch(`${address}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
for (const minimal of [true, false]) test(`Responses three turns, mixed transport, minimal=${minimal}`, async () => {
  const sent = []; setup(`responses-${minimal}`, { sent });
  let id;
  const input = [];
  for (let turn = 1; turn <= 3; turn++) {
    input.push({ role: "user", content: `Question ${turn}` });
    const stream = turn !== 2;
    const res = await post({ model: "auto", input: minimal ? `Question ${turn}` : input, stream, max_output_tokens: 1,
      ...(id ? { metadata: { conversation_id: id } } : {}) });
    assert.equal(res.status, 200);
    let body;
    if (stream) {
      const wire = await res.text();
      assert.ok(!wire.includes("chat.completion"));
      const events = wire.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
      assert.equal(events[0].type, "response.created");
      assert.equal(events.at(-1).type, "response.completed");
      assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
      body = events.at(-1).response;
      assert.equal(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), body.output[0].content[0].text);
      assert.ok(wire.includes("event: response.completed\n"));
    } else body = await res.json();
    assert.equal(body.object, "response"); assert.equal(body.status, "completed");
    assert.match(body.id, /^resp_/); assert.equal(body.usage, null);
    id ??= body.metadata.conversation_id;
    assert.equal(body.metadata.conversation_id, id);
    assert.equal(body.output[0].content[0].text, `reply-${turn}`);
    input.push(body.output[0]);
    assert.equal(store.countConversations(`responses-${minimal}`), 1);
    assert.equal(store.listMessages(id).at(-1).content, `reply-${turn}`);
    const requests = sent.filter(item => item.pathname.endsWith("/f/conversation"));
    assert.equal(requests.at(-1).body.parent_message_id, turn === 1 ? "client-created-root" : `assistant-${turn - 1}`);
  }
});
test("one-shot, instructions and input_text", async () => {
  setup("one-shot");
  const res = await post({ input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }], instructions: "Be helpful", store: false, metadata: { conversation_id: "ignored" } });
  const body = await res.json(); assert.equal(body.status, "completed");
  assert.equal(body.instructions, "Be helpful"); assert.equal(body.metadata.conversation_id, undefined);
  assert.equal(res.headers.get("x-mirror-conversation-id"), null);
  assert.equal(store.countConversations("one-shot"), 0);
});
test("unsupported features fail before upstream access", async () => {
  setup("invalid"); globalThis.fetch = async () => { throw new Error("Must not call upstream"); };
  for (const extra of [{ tools: [] }, { previous_response_id: "resp_123" }, { background: true }, { input: "" }, { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.com/x" }] }] }]) {
    const res = await post({ input: "Hello", ...extra }); assert.equal(res.status, 400); assert.ok((await res.json()).error);
  }
});
test("upstream errors produce response.failed without successful completion", async () => {
  setup("failure"); globalThis.fetch = async () => { throw new Error("Synthetic upstream failure"); };
  const res = await post({ input: "Hello", stream: true });
  const wire = await res.text(); assert.ok(wire.includes("event: response.failed")); assert.ok(!wire.includes("event: response.completed"));
});
test("Chat and Responses share history and reject assistant edits", async () => {
  const sent = []; setup("cross-mode", { sent });
  const first = await (await post({ input: "First question" })).json();
  const id = first.metadata.conversation_id;
  const chat = await localFetch(`${address}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{role:"user",content:"Second question"}], metadata:{conversation_id:id} }) });
  assert.equal(chat.status, 200); const second = await chat.json();
  assert.equal(second.choices[0].message.content, "reply-2");
  const requestCount = sent.length;
  const edited = await post({ input:[{role:"user",content:"First question"},{role:"assistant",content:"Edited"},{role:"user",content:"Third question"}], metadata:{conversation_id:id} });
  assert.equal(edited.status,400); assert.equal(sent.length,requestCount);
  const third = await (await post({input:"Third question",metadata:{conversation_id:id}})).json();
  assert.equal(third.output[0].content[0].text,"reply-3"); assert.equal(third.metadata.conversation_id,id);
  assert.equal(store.countConversations("cross-mode"),1);
});
