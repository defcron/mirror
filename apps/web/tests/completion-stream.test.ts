import assert from "node:assert/strict";
import test from "node:test";
import {readCompletionStream} from "../src/completion-stream.js";
const parse = async (s: string) => { let text=""; const body = new ReadableStream<Uint8Array>({start(c){for(const byte of new TextEncoder().encode(s)) c.enqueue(new Uint8Array([byte]));c.close();}}); const result=await readCompletionStream(body,t=>text=t,()=>{},()=>{});return {text,result}; };
test("completion reader survives UTF-8 boundaries",async()=>{assert.deepEqual(await parse('data: {"choices":[{"delta":{"content":"héllo"},"finish_reason":null}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),{text:"héllo",result:"héllo"});});
test("stream errors never become success",async()=>{await assert.rejects(parse('data: {"error":{"message":"failed"}}\n\ndata: [DONE]\n\n'),/failed/);});
test("truncated streams never become success",async()=>{await assert.rejects(parse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),/interrupted/);});
