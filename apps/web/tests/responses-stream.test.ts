import assert from "node:assert/strict";
import test from "node:test";
import { readResponsesStream } from "../src/responses-stream.js";
function stream(events: unknown[]) {
  const bytes = new TextEncoder().encode(events.map(e => `event: ignored\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
  return new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
}
test.describe("web / responses-stream", () => {
test("Responses handles UTF-8 byte splits, terminal text and continuation metadata", async () => {
  let id = "";
  const text = await readResponsesStream(stream([
    { type: "response.output_text.delta", delta: "hé🙂" },
    { type: "response.completed", response: { status: "completed", metadata: { conversation_id: "conversation" }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hé🙂" }] }] } },
  ]), () => {}, () => {}, value => { id = value; });
  assert.equal(text, "hé🙂"); assert.equal(id, "conversation");
});
test("Responses never treats truncated or failed streams as complete", async () => {
  for (const tail of [[], [{ type: "response.failed", response: { error: { message: "Synthetic failure" } } }], [{ type: "response.incomplete" }]]) {
    let partial = "";
    await assert.rejects(readResponsesStream(stream([{ type: "response.output_text.delta", delta: "Partial" }, ...tail]), text => { partial = text; }, () => {}, () => {}));
    assert.equal(partial, "Partial");
  }
});

test("Responses validates terminal envelopes and assistant text parts", async () => {
  const { responseText } = await import("../src/responses-stream.js");
  for (const value of [null, {}, { status: "failed", error: { message: "Explicit failure" } },
    { status: "completed", output: [] },
    { status: "completed", output: [{ type: "message", role: "assistant" }] },
    { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: 1 }] }] }]) {
    assert.throws(() => responseText(value), /failure|complete|assistant text/i);
  }
  assert.equal(responseText({ status: "completed", output: [
    { type: "reasoning" }, { type: "message", role: "user" },
    { type: "message", role: "assistant", content: [{ type: "other" }, { type: "output_text", text: "A" }, { type: "output_text", text: "B" }] },
  ] }), "AB");
});

test("Responses ignores SSE comments and flushes a final unterminated frame", async () => {
  const value = ': heartbeat\n\nevent: response.created\n\ndata: ' + JSON.stringify({ type: "response.completed", response: {
    status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "final" }] }],
  } });
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(value)); c.close(); } });
  assert.equal(await readResponsesStream(body, () => {}, () => {}, () => assert.fail("Unexpected conversation ID")), "final");
});

test("Responses reports invalid deltas and every supported error envelope", async () => {
  for (const [event, expected] of [
    [{ type: "response.output_text.delta", delta: 42 }, /Invalid response text delta/],
    [{ type: "error", error: { message: "nested error" } }, /nested error/],
    [{ type: "error", message: "flat error" }, /flat error/],
    [{ type: "response.incomplete" }, /partial output is preserved/],
  ] as const) {
    await assert.rejects(readResponsesStream(stream([event]), () => {}, () => {}, () => {}), expected);
  }
});
});
