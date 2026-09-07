import assert from "node:assert/strict";
import test from "node:test";
import {readCompletionStream} from "../src/completion-stream.js";
const parse = async (s: string) => { let text=""; const body = new ReadableStream<Uint8Array>({start(c){for(const byte of new TextEncoder().encode(s)) c.enqueue(new Uint8Array([byte]));c.close();}}); const result=await readCompletionStream(body,t=>text=t,()=>{},()=>{});return {text,result}; };
test("completion reader survives UTF-8 boundaries",async()=>{assert.deepEqual(await parse('data: {"choices":[{"delta":{"content":"héllo"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),{text:"héllo",result:"héllo"});});
test("stream errors never become success",async()=>{await assert.rejects(parse('data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n'),/failed/);});
test("stream errors fall back to a generic message with no error.message",async()=>{await assert.rejects(parse('data: {"error":{}}\n\ndata: [DONE]\n\n'),/Generation failed/);});
test("truncated streams never become success",async()=>{await assert.rejects(parse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),/interrupted/);});

test("a mirror-conversation-id comment line is reported via onConversation", async () => {
  const seen: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          ': mirror-conversation-id abc-123 \n\ndata: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
      c.close();
    },
  });
  const result = await readCompletionStream(
    body,
    () => {},
    () => {},
    (id) => seen.push(id),
  );
  assert.deepEqual(seen, ["abc-123"]);
  assert.equal(result, "hi");
});

test("a frame with no data lines at all is ignored", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          ": just a comment, no data\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        ),
      );
      c.close();
    },
  });
  let text = "";
  const result = await readCompletionStream(body, (t) => (text = t), () => {}, () => {});
  assert.equal(result, "ok");
});

test("onRaw receives the accumulated raw JSON lines", async () => {
  const raws: string[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ),
      );
      c.close();
    },
  });
  await readCompletionStream(body, () => {}, (r) => raws.push(r), () => {});
  assert.ok(raws.length >= 2);
  assert.ok(raws.at(-1)?.includes('"content":"b"'));
});

test("a final DONE marker needs no trailing blank line", async () => {
  assert.deepEqual(await parse('data: {"choices":[{"delta":{"content":"tail"},"finish_reason":"stop"}]}\n\ndata: [DONE]'), { text: "tail", result: "tail" });
});
