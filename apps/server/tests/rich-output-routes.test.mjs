import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stubBackend, assistantAddFrame } from "./helpers/backend.mjs";
const dir = mkdtempSync(path.join(tmpdir(), "mirror-rich-routes-"));
process.env.MIRROR_DATA_DIR = dir;
delete process.env.MIRROR_STORE_KEY;
const { default: Fastify } = await import("fastify");
const store = await import("../dist/store.js");
const { registerOpenAiRoutes } = await import("../dist/openai.js");
const app = Fastify(); await registerOpenAiRoutes(app);
const address = await app.listen({host:"127.0.0.1",port:0});
const localFetch = globalThis.fetch;
test.after(async()=>{globalThis.fetch=localFetch;await app.close();rmSync(dir,{recursive:true,force:true});});
const download = "https://files.oaiusercontent.com/test?sig=synthetic";
for (const endpoint of ["chat/completions","responses"]) for (const stream of [false,true]) test(`${endpoint} stream=${stream}: rich output, summary, downloads and three-turn continuity`,async()=>{
  const account=`rich-${endpoint}-${stream}`;
  store.saveVerifiedSession("synthetic-session",account,"synthetic-device");
  store.updateMintedToken("synthetic-access",Date.now()+3600000,null);
  const sent=[],downloads=[];
  const backend=stubBackend(account,{sent,turnFrames:(body,turn)=>{
    if(turn>1)return [assistantAddFrame(body.conversation_id,`assistant-${turn}`,`reply-${turn}`),"[DONE]"];
    const add=(id,role,content,extra={})=>({p:"",o:"add",v:{conversation_id:"upstream-rich",message:{id,author:{role,...(role==="tool"?{name:"python_user_visible"}:{})},content,...extra}}});
    return [
      add("summary","assistant",{content_type:"reasoning_recap",text:"Checked the generated report."}),
      add("tool","tool",{content_type:"execution_output",stdout:"starting"}),
      {p:"/message/content/stdout",o:"append",v:"\nfinished"},
      {p:"/message/content/stderr",o:"add",v:"sample warning"},
      add("assistant-1","assistant",{content_type:"text",parts:["Here is "]}),
      {p:"/message/content/parts/0",o:"append",v:"\uE200filecite"},
      {p:"/message/content/parts/0",o:"append",v:"\uE202turn0file0\uE201 and [plot](sandbox:/mnt/data/plot.png)."},
      {p:"/message/metadata/content_references",o:"add",v:[{file_id:"file-report",name:"report.csv",matched_text:"\uE200filecite\uE202turn0file0\uE201"}]},
      {p:"/message/status",o:"replace",v:"finished_successfully"},"[DONE]"
    ];
  }});
  globalThis.fetch=async(url,init)=>{
    const parsed=new URL(String(url));
    if(parsed.pathname.endsWith("/download")){downloads.push(parsed);return Response.json({download_url:download});}
    return backend(url,init);
  };
  const history=[];let conversation;
  for(let turn=1;turn<=3;turn++){
    history.push({role:"user",content:`Question ${turn}`});
    const body={stream,...(endpoint==="responses"?{input:history,reasoning:{summary:"auto"}}:{messages:history}),...(conversation?{metadata:{conversation_id:conversation}}:{})};
    const res=await localFetch(`${address}/v1/${endpoint}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    assert.equal(res.status,200);
    let answer,metadata,output;
    if(stream){
      const wire=await res.text();
      const events=wire.split("\n").filter(l=>l.startsWith("data: ")&&l!=="data: [DONE]").map(l=>JSON.parse(l.slice(6)));
      if(endpoint==="responses"){
        output=events.at(-1).response;assert.equal(output.status,"completed");
        answer=events.filter(e=>e.type==="response.output_text.delta").map(e=>e.delta).join("");
        assert.equal(answer,output.output[0].content[0].text);metadata=output.metadata;
        if(turn===1)assert.ok(events.some(e=>e.type==="response.reasoning_summary_text.delta"));
      }else{
        answer=events.map(e=>e.choices?.[0]?.delta?.content??"").join("");metadata=events.at(-1).metadata;
        conversation??=wire.match(/: mirror-conversation-id ([^\n]+)/)?.[1];
      }
    }else{
      output=await res.json();metadata=output.metadata;
      answer=endpoint==="responses"?output.output[0].content[0].text:output.choices[0].message.content;
      conversation??=res.headers.get("x-mirror-conversation-id");
    }
    conversation??=metadata?.conversation_id;
    if(turn===1){
      assert.match(answer,/starting\nfinished/);assert.match(answer,/sample warning/);
      assert.match(answer,/Here is \[report.csv\]\(<https:\/\/files.oaiusercontent.com/);
      assert.ok(!/[\uE000-\uF8FF]|sandbox:|file-service:/.test(answer));
      assert.equal(JSON.parse(metadata.mirror_assets).length,2);
      assert.equal(downloads.find(u=>u.pathname.includes("interpreter")).searchParams.get("sandbox_path"),"/mnt/data/plot.png");
      if(endpoint==="responses"&&output)assert.equal(output.output[1].type,"reasoning");
    }else assert.equal(answer,`reply-${turn}`);
    assert.equal(store.listMessages(conversation).at(-1).content,answer);
    history.push({role:"assistant",content:answer});
    assert.equal(sent.filter(s=>s.pathname.endsWith("/f/conversation")).at(-1).body.parent_message_id,turn===1?"client-created-root":`assistant-${turn-1}`);
  }
  assert.equal(store.countConversations(account),1);
});

for (const model of ["g-custom", "g-p-project", "model-a"]) for (const endpoint of ["chat/completions", "responses"]) for (const stream of [false, true]) {
  test(`${model} ${endpoint} stream=${stream}: first-turn extras hidden, Python retained, follow-up unchanged`, async () => {
    const account = `visibility-${model}-${endpoint}-${stream}`;
    store.saveVerifiedSession("synthetic-session", account, "synthetic-device");
    store.updateMintedToken("synthetic-access", Date.now() + 3600000, null);
    const sent = [], downloads = [];
    const backend = stubBackend(account, { sent, turnFrames: (body, turn) => {
      const add = (id, role, name, content, extra = {}) => ({ p: "", o: "add", v: {
        conversation_id: body.conversation_id ?? `up-${account}`, message: {
          id, author: { role, ...(name ? { name } : {}) }, content, ...extra,
        },
      } });
      return [
        add(`preamble-${turn}`, "assistant", null, { content_type: "text", parts: ["SEARCH PREAMBLE"] }, { channel: "commentary" }),
        add(`search-${turn}`, "tool", "file_search.msearch", { content_type: "text", parts: ["SEARCH LOG"] }),
        { p: "/message/content/parts/0", o: "append", v: " MORE SEARCH LOG" },
        { p: "/message/metadata", o: "add", v: { asset_pointer: "file-service://search-only", name: "SEARCH ATTACHMENT" } },
        { type: "tool_status", tool_name: "file_search.mclick", text: "TYPED SEARCH LOG", asset_pointer: "file-service://typed-only" },
        add(`summary-${turn}`, "assistant", null, { content_type: "reasoning_recap", text: "EXTRA SUMMARY" }),
        add(`python-${turn}`, "tool", "python", { content_type: "execution_output", stdout: "PYTHON STDOUT" }),
        { p: "/message/content/stderr", o: "add", v: "PYTHON STDERR" },
        add(`visible-python-${turn}`, "tool", "python_user_visible", { content_type: "execution_output", parts: ["VISIBLE PYTHON"] }),
        add(`assistant-${turn}`, "assistant", null, { content_type: "text", parts: [`Normal answer ${turn}.`] }, { channel: "final", status: "finished_successfully" }),
        "[DONE]",
      ];
    } });
    globalThis.fetch = async (url, init) => {
      if (new URL(String(url)).pathname.endsWith("/download") || new URL(String(url)).pathname.includes("/files/download/")) { downloads.push(String(url)); return Response.json({ download_url: download }); }
      return backend(url, init);
    };
    const history = []; let conversation;
    for (let turn = 1; turn <= 3; turn++) {
      downloads.length = 0;
      history.push({ role: "user", content: `Question ${turn}` });
      const body = { model, stream, ...(endpoint === "responses" ? { input: history, reasoning: { summary: "auto" } } : { messages: history }),
        ...(conversation ? { metadata: { conversation_id: conversation } } : {}) };
      const res = await localFetch(`${address}/v1/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 200);
      let answer, metadata, output;
      if (stream) {
        const wire = await res.text();
        conversation ??= wire.match(/: mirror-conversation-id ([^\n]+)/)?.[1];
        const events = wire.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6)));
        if (endpoint === "responses") {
          output = events.at(-1).response; assert.equal(output.status, "completed");
          answer = events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("");
          assert.equal(answer, output.output[0].content[0].text); metadata = output.metadata;
        } else {
          answer = events.map(e => e.choices?.[0]?.delta?.content ?? "").join(""); metadata = events.at(-1).metadata;
        }
      } else {
        output = await res.json(); metadata = output.metadata;
        conversation ??= res.headers.get("x-mirror-conversation-id");
        answer = endpoint === "responses" ? output.output[0].content[0].text : output.choices[0].message.content;
      }
      conversation ??= metadata.conversation_id;
      assert.match(answer, /PYTHON STDOUT/); assert.match(answer, /PYTHON STDERR/); assert.match(answer, /VISIBLE PYTHON/);
      assert.match(answer, new RegExp(`Normal answer ${turn}\\.`));
      const hidden = model.startsWith("g-") && turn === 1;
      if (hidden) {
        assert.doesNotMatch(JSON.stringify({ answer, metadata, output }), /SEARCH|file_search|EXTRA SUMMARY/);
        assert.equal(downloads.length, 0);
      } else {
        assert.match(answer, /SEARCH LOG MORE SEARCH LOG/);
        assert.match(answer, /TYPED SEARCH LOG/);
        assert.match(metadata.mirror_tool_events, /file_search/);
        assert.ok(downloads.length > 0);
      }
      const saved = store.listMessages(conversation).at(-1);
      assert.equal(saved.content, answer);
      assert.ok(saved.events.some(e => e.kind === "tool" && e.name === "file_search.msearch"));
      history.push({ role: "assistant", content: answer });
      assert.equal(sent.filter(s => s.pathname.endsWith("/f/conversation")).at(-1).body.parent_message_id, turn === 1 ? "client-created-root" : `assistant-${turn - 1}`);
    }
    assert.equal(store.countConversations(account), 1);
  });
}

for (const scenario of ["image", "sandbox", "plain-prefix", "empty-tool"]) test(`Responses rich stream: ${scenario}`, async () => {
  const account = `rich-stream-${scenario}`;
  store.saveVerifiedSession("synthetic-session", account, "synthetic-device");
  store.updateMintedToken("synthetic-access", Date.now() + 3600000, null);
  const downloads = [];
  const backend = stubBackend(account, { turnFrames: () => {
    const answer = assistantAddFrame("upstream", "answer", "First line\nSecond line\n");
    if (scenario === "image") return [assistantAddFrame("upstream", "answer", "An image: sediment://image"), "[DONE]"];
    if (scenario === "sandbox") return [{ type: "attachment", asset_pointer: "sandbox:/mnt/data/extra.csv" }, assistantAddFrame("upstream", "answer", "[Report](sandbox:/mnt/data/report.csv)"), "[DONE]"];
    if (scenario === "plain-prefix") return [answer, { p: "/message/content/parts/0", o: "append", v: "[ordinary label] is text\n" }, "[DONE]"];
    // An empty tool status must not insert a heading into the answer.
    return [{ p: "", o: "add", v: { message: { id: "tool", author: { role: "tool", name: "python" }, content: { content_type: "text", parts: [] } } } }, answer, "[DONE]"];
  } });
  globalThis.fetch = async (url, init) => {
    if (new URL(String(url)).pathname.endsWith("/download") || new URL(String(url)).pathname.includes("/files/download/")) { downloads.push(String(url)); return Response.json({ download_url: download }); }
    return backend(url, init);
  };
  const res = await localFetch(`${address}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Question", stream: true }) });
  const events = (await res.text()).split("\n").filter(l => l.startsWith("data: ")).map(l => JSON.parse(l.slice(6)));
  assert.equal(events.at(-1).type, "response.completed");
  const completed = events.at(-1).response;
  const answer = events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("");
  assert.equal(answer, completed.output[0].content[0].text);
  if (scenario === "image") assert.match(completed.metadata.mirror_images, /files.oaiusercontent.com/);
  if (scenario === "sandbox") assert.equal(new URL(downloads[0]).searchParams.get("message_id"), "answer");
  if (scenario === "plain-prefix") assert.equal(answer, "First line\nSecond line\n[ordinary label] is text\n");
  if (scenario === "empty-tool") assert.equal(answer, "First line\nSecond line\n");
});
