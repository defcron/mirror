import assert from "node:assert/strict";
import test from "node:test";
import { renderRichOutput, visibleSummary } from "../dist/rich-output.js";
import { ConversationStreamReducer } from "@mirror/protocol";
const text = (value) => ({ kind: "assistant_text", messageId: "a", text: value, delta: value });
const message = (raw) => ({ kind: "message", messageId: "a", role: "assistant", raw });
const url = "https://files.oaiusercontent.com/example?sig=synthetic&expires=123";

test("late citation mapping replaces private marker inline and preserves the surrounding answer", async () => {
  const marker = "\uE200filecite\uE202turn0file0\uE201";
  const calls = [];
  const result = await renderRichOutput([text(`Before ${marker} after.`), message({ metadata: { content_references: [{ matched_text: marker, file_id: "file-1", name: "report.csv" }] } })], "", async p => { calls.push(p); return url; });
  assert.equal(result.text, `Before [report.csv](<${url}>) after.`);
  assert.deepEqual(calls, ["file-service://file-1"]);
});
test("sandbox and image pointers keep Markdown positions; duplicate pointer snapshots resolve once", async () => {
  const value = "First [report](sandbox:/mnt/data/report.csv) then ![plot](sediment://file-plot) done.";
  const result = await renderRichOutput([text(value), text(value)], "", async () => url);
  assert.equal(result.text, `First [report](<${url}>) then ![plot](<${url}>) done.`);
  assert.equal(result.assets.length, 2);
});
test("sandbox metadata alias uses its file id without a second failed download", async () => {
  const calls = [];
  const result = await renderRichOutput([text("[report](sandbox:/mnt/data/r.csv)"), message({ metadata: { references: [{ file_id: "file-r", path: "sandbox:/mnt/data/r.csv" }] } })], "", async p => { calls.push(p); return url; });
  assert.equal(result.text, `[report](${url})`);
  assert.deepEqual(calls, ["file-service://file-r"]);
});
test("failed and non-HTTPS downloads do not leak internal reference syntax or create executable links", async () => {
  for (const resolver of [async () => { throw new Error("private upstream error"); }, async () => "javascript:alert(1)"]) {
    const result = await renderRichOutput([text("[x](file-service://file-x) \uE200unknown\uE201")], "", resolver);
    assert.equal(result.text, "[x] (download unavailable) [Reference unavailable]");
    assert.equal(result.assets[0].status, "unavailable");
  }
});
test("tool patches preserve complete stdout, stderr and widget plain text at the tool's position", async () => {
  const tool = raw => ({kind:"tool", messageId:"python-1",name:"python_user_visible",raw});
  const result = await renderRichOutput([text("Start."), tool({content:{stdout:"1"}}), tool({content:{stdout:"12",stderr:"warning",data:{"text/plain":"table view","text/html":"<script>bad()</script>"}}}), text("Start. Finished.")], "", async () => url);
  assert.match(result.text, /Start\.[\s\S]*python_user_visible[\s\S]*12[\s\S]*warning[\s\S]*table view[\s\S]*Finished\./);
  assert.ok(!result.text.includes("<script>"));
  assert.equal(result.tools.length, 1);
});
test("only explicit summaries are classified as reasoning summaries", () => {
  assert.equal(visibleSummary({channel:"analysis",content:{content_type:"text",parts:["internal"]}}), "");
  assert.equal(visibleSummary({content:{content_type:"reasoning_recap",text:"Checked the totals."}}), "Checked the totals.");
});
test("multipart and generic tool patches survive reducer snapshots without object coercion", () => {
  const reducer = new ConversationStreamReducer();
  reducer.feed(JSON.stringify({p:"",o:"add",v:{message:{id:"a",author:{role:"assistant"},content:{content_type:"multimodal_text",parts:["Before",{content_type:"image_asset_pointer",asset_pointer:"sediment://file-image"},"After"]}}}}));
  const before = reducer.drainEvents();
  assert.equal(reducer.text, "Before\n\nsediment://file-image\n\nAfter");
  reducer.feed(JSON.stringify({p:"/message/content/parts/2",o:"append",v:"!"}));
  assert.equal(reducer.text, "Before\n\nsediment://file-image\n\nAfter!");
  assert.equal(before.find(e=>e.kind==="message").raw.content.parts[2], "After");
  reducer.feed(JSON.stringify({p:"",o:"add",v:{message:{id:"t",author:{role:"tool",name:"python_user_visible"},content:{content_type:"execution_output",stdout:"one"}}}}));
  reducer.drainEvents();
  reducer.feed(JSON.stringify({p:"/message/content/stdout",o:"append",v:" two"}));
  assert.equal(reducer.drainEvents().find(e=>e.kind==="tool").raw.content.stdout, "one two");
});
test("partial pointer snapshots never trigger downloads for incomplete file IDs", async () => {
  const calls=[];
  const result = await renderRichOutput([text("file-service://fi"),text("file-service://file-complete")], "", async p => {calls.push(p);return url;});
  assert.deepEqual(calls,["file-service://file-complete"]);
  assert.equal(result.text,`[Download file](<${url}>)`);
});

test("summary parts, tool log arrays, empty labels and unrelated events render safely", async () => {
  assert.equal(visibleSummary({ content: { content_type: "summary", parts: ["first", null, "second"] } }), "first\nsecond");
  assert.equal(visibleSummary({ content: { content_type: "summary" } }), "");
  const result = await renderRichOutput([
    { kind: "status", messageId: "a", status: "done" },
    { kind: "tool", name: "[]<>\n", messageId: null, raw: { content: { logs: ["one", "two"], stderr: ["mixed", 2] } } },
    { kind: "citation", raw: [null, 2, true] },
  ], "", async () => assert.fail("No assets expected"));
  assert.match(result.text, /\*\*Download file\*\*/);
  assert.match(result.text, /one\ntwo/);
  assert.doesNotMatch(result.text, /mixed/);
  assert.equal((await renderRichOutput([], "fallback", async () => url)).text, "fallback");
});

test("standalone output assets render images and file labels once, with explicit unavailable links", async () => {
  const events = [
    { kind: "image", assetPointer: "sediment://image", raw: {} },
    { kind: "file", assetPointer: "file-service://file", title: "Report", raw: {} },
    { kind: "file", assetPointer: "file-service://untitled", raw: {} },
    { kind: "file", assetPointer: "file-service://file", title: "Duplicate", raw: {} },
  ];
  const result = await renderRichOutput(events, "", async () => url);
  assert.match(result.text, /!\[Image\]/);
  assert.match(result.text, /\[Report\]/);
  assert.equal(result.assets.length, 3);
  const failed = await renderRichOutput([text("sediment://missing")], "", async () => { throw new Error("unavailable"); });
  assert.equal(failed.text, "[Download file — download unavailable]");
});

test("an unavailable sandbox alias whose label repeats its path leaves no raw sandbox pointer", async () => {
  const pointer = "sandbox:/mnt/data/report.csv";
  const result = await renderRichOutput([text(pointer), message({ metadata: { references: [{ file_id: "report", path: pointer, name: pointer }] } })], "", async () => { throw new Error("Unavailable"); });
  assert.doesNotMatch(result.text, /sandbox:|file-service:/);
  assert.match(result.text, /Download file — download unavailable/);
  assert.equal(result.assets.length, 1);
});
