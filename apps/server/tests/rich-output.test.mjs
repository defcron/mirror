import assert from "node:assert/strict";
import test from "node:test";
import { renderRichOutput, visibleSummary } from "../dist/rich-output.js";
import { ConversationStreamReducer } from "@mirror/protocol";
const text = (value) => ({ kind: "assistant_text", messageId: "a", text: value, delta: value });
const message = (raw) => ({ kind: "message", messageId: "a", role: "assistant", raw });
const url = "https://files.oaiusercontent.com/example?sig=synthetic&expires=123";

test.describe("server / rich-output", () => {
test("late citation mapping replaces private marker inline and preserves the surrounding answer", async () => {
  const marker = "\uE200filecite\uE202turn0file0\uE201";
  const calls = [];
  const result = await renderRichOutput([text(`Before ${marker} after.`), message({ metadata: { content_references: [{ matched_text: marker, file_id: "file-1", name: "report.csv" }] } })], "", async p => { calls.push(p); return url; });
  assert.equal(result.text, `Before Download file: [report.csv](<${url}>) after.`);
  assert.deepEqual(calls, ["file-service://file-1"]);
});
test("web-search citation markers resolve to the real title/url from content_references", async () => {
  const marker = "\uE200cite\uE202turn0search0\uE201";
  const result = await renderRichOutput([
    text(`Ground Control to Major Tom is from ${marker} 1969 song.`),
    message({ metadata: { content_references: [{ matched_text: marker, type: "webpage", title: "David Bowie", url: "https://en.wikipedia.org/wiki/David_Bowie" }] } }),
  ], "", async () => url);
  assert.equal(result.text, `Ground Control to Major Tom is from [David Bowie](<https://en.wikipedia.org/wiki/David_Bowie>) 1969 song.`);
  assert.ok(!result.text.includes("Reference unavailable"));
});
test("non-webpage citation shapes (mcp_source, grouped_webpages, description-only) resolve their display text", async () => {
  const m1 = "\uE200cite\uE202turn0mcp0\uE201";
  const m2 = "\uE200cite\uE202turn0group0\uE201";
  const m3 = "\uE200cite\uE202turn0hidden0\uE201";
  const result = await renderRichOutput([
    text(`See ${m1}, also ${m2}, and note ${m3}.`),
    message({
      metadata: {
        content_references: [
          { matched_text: m1, type: "mcp_source", title: "Internal Wiki", url: "https://wiki.internal/page", tool_name: "search" },
          { matched_text: m2, type: "grouped_webpages", items: [{ title: "Example Source", url: "https://example.com/a" }, { title: "Other", url: "https://example.com/b" }] },
          { matched_text: m3, type: "hidden", description: "A short internal description with no link" },
        ],
      },
    }),
  ], "", async () => url);
  assert.equal(result.text, "See [Internal Wiki](<https://wiki.internal/page>), also [Example Source](<https://example.com/a>), and note A short internal description with no link.");
  assert.ok(!result.text.includes("Reference unavailable"));
});
test("citation data delivered after the message via a citation_patch event still resolves (sidebar/popup references)", async () => {
  const marker = "\uE200cite\uE202turn0async0\uE201";
  const citationPatch = (messageId, contentReferences) => ({ kind: "citation_patch", messageId, contentReferences, raw: {} });
  const result = await renderRichOutput([
    text(`See the ${marker} for details.`),
    citationPatch("a", [{ matched_text: marker, type: "hidden", description: "Async sidebar description" }]),
  ], "", async () => url);
  assert.equal(result.text, "See the Async sidebar description for details.");
  assert.ok(!result.text.includes("Reference unavailable"));
});
test("inline self-contained widget markers (entity, image_group) render without content_references", async () => {
  // Real markers observed from a live ChatGPTBox session: the type name and
  // its JSON payload are separated by ChatGPT's own \uE202 marker, not
  // placed directly adjacent - confirmed via code-point-level server logs.
  const entityMarker = "\uE200entity\uE202[\"musical_artist\",\"David Bowie\",\"English singer-songwriter\"]\uE201";
  const songMarker = "\uE200entity\uE202[\"song\",\"Space Oddity\",\"David Bowie 1969 song\"]\uE201";
  const imageGroupMarker = "\uE200image_group\uE202{\"layout\":\"bento\",\"aspect_ratio\":\"16:9\",\"query\":[\"David Bowie Space Oddity Major Tom astronaut\",\"David Bowie 1969 Space Oddity performance\"]}\uE201";
  const result = await renderRichOutput([
    text(`${entityMarker}'s ${songMarker}.${imageGroupMarker}`),
  ], "", async () => url);
  assert.equal(result.text, "David Bowie's Space Oddity.");
  assert.ok(!result.text.includes("Reference unavailable"));
});
test("sandbox and image pointers keep Markdown positions; duplicate pointer snapshots resolve once", async () => {
  const value = "First [report](sandbox:/mnt/data/report.csv) then ![plot](sediment://file-plot) done.";
  const result = await renderRichOutput([text(value), text(value)], "", async () => url);
  assert.equal(result.text, `First Download file: [report.csv](<${url}>) then ![file-plot](<${url}>)\n\nDownload file: [file-plot](<${url}>) done.`);
  assert.equal(result.assets.length, 2);
});
test("sandbox metadata alias uses its file id without a second failed download", async () => {
  const calls = [];
  const result = await renderRichOutput([text("[report](sandbox:/mnt/data/r.csv)"), message({ metadata: { references: [{ file_id: "file-r", path: "sandbox:/mnt/data/r.csv" }] } })], "", async p => { calls.push(p); return url; });
  assert.equal(result.text, `Download file: [r.csv](<${url}>)`);
  assert.deepEqual(calls, ["file-service://file-r"]);
});
test("failed and non-HTTPS downloads do not leak internal reference syntax or create executable links", async () => {
  for (const resolver of [async () => { throw new Error("private upstream error"); }, async () => "javascript:alert(1)"]) {
    const result = await renderRichOutput([text("[x](file-service://file-x) \uE200unknown\uE201")], "", resolver);
    assert.equal(result.text, "[file-x — download unavailable] [Reference unavailable]");
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
  assert.equal(result.text,`Download file: [file-complete](<${url}>)`);
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
  assert.match(result.text, /!\[image\]/);
  assert.match(result.text, /\[Report\]/);
  assert.equal(result.assets.length, 3);
  const failed = await renderRichOutput([text("sediment://missing")], "", async () => { throw new Error("unavailable"); });
  assert.equal(failed.text, "[missing — download unavailable]");
});

test("an unavailable sandbox alias whose label repeats its path leaves no raw sandbox pointer", async () => {
  const pointer = "sandbox:/mnt/data/report.csv";
  const result = await renderRichOutput([text(pointer), message({ metadata: { references: [{ file_id: "report", path: pointer, name: pointer }] } })], "", async () => { throw new Error("Unavailable"); });
  assert.doesNotMatch(result.text, /sandbox:|file-service:/);
  assert.match(result.text, /report.csv — download unavailable/);
  assert.equal(result.assets.length, 1);
});

test("filenames, preview and download URLs survive ChatGPTBox Markdown parsing", async () => {
  const pointer = "sandbox:/mnt/data/résumé [final](1).png";
  const value = `![preview](<${pointer}>)\n\n[Download now](<${pointer}>)`;
  const calls = [];
  const links = { url: "http://127.0.0.1:8787/api/asset-content?ticket=synthetic", downloadUrl: "http://127.0.0.1:8787/api/asset-content?ticket=synthetic&download=1", fileName: "résumé [final](1).png" };
  const result = await renderRichOutput([text(value)], "", async p => { calls.push(p); return links; });
  const { fromMarkdown } = await import("mdast-util-from-markdown");
  const tree = fromMarkdown(result.text), nodes = [];
  const visit = n => { nodes.push(n); n.children?.forEach(visit); }; visit(tree);
  assert.deepEqual(calls, [pointer]);
  assert.equal(nodes.find(n => n.type === "image").url, links.url);
  assert.equal(nodes.find(n => n.type === "image").alt, links.fileName);
  const downloads = nodes.filter(n => n.type === "link");
  assert.equal(downloads.length, 2);
  assert.ok(downloads.every(n => n.url === links.downloadUrl && n.children[0].value === links.fileName));
  assert.doesNotMatch(result.text, /Download now|sandbox:/);
});

test("reference links and sandbox aliases use a full escaped destination and filename", async () => {
  const pointer = "sandbox:/mnt/data/report(1).csv";
  const value = `Download file: [Download now][report]\n\n[report]: <${pointer}>`;
  const calls = [];
  const result = await renderRichOutput([text(value), message({ metadata: { references: [{ file_id: "file-1", path: pointer }] } })], "", async p => { calls.push(p); return "https://files.oaiusercontent.com/file(1)?a=1&b=2"; });
  assert.deepEqual(calls, ["file-service://file-1"]);
  assert.match(result.text, /^Download file: \[report\(1\).csv\]\(<https:/);
  assert.doesNotMatch(result.text, /Download file: Download file:|sandbox:/);
});

test("embedded previews and literal percent filenames preserve safe Markdown", async () => {
  const result = await renderRichOutput([text("![preview](sandbox:/mnt/data/20%.png)")], "", async () => ({
    url: "data:image/png;base64,aGVsbG8=", downloadUrl: "http://localhost/api/asset-content?ticket=synthetic", fileName: "20%.png",
  }));
  assert.match(result.text, /!\[20%\.png\]\(<data:image\/png;base64,aGVsbG8=>\)/);
  const fallback = await renderRichOutput([text("[Download now](sandbox:/mnt/data/20%.csv)")], "", async () => url);
  assert.match(fallback.text, /Download file: \[20%\.csv\]/);
  const partial = await renderRichOutput([text("sandbox:/mnt/data/report\n[full](sandbox:/mnt/data/report(1).csv)")], "", async () => url);
  assert.match(partial.text, /Download file: \[report\]/);
});
});
