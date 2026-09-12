import assert from "node:assert/strict";
import test from "node:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
const dir = mkdtempSync(path.join(tmpdir(), "mirror-reliability-"));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = "test-control-key";
const store = await import("../dist/store.js");
const {syncConversationPage, hasRemoteHistory} = await import("../dist/conversation-sync.js");
const {buildApp} = await import("../dist/index.js");
const {controlCookie, authorizedLocalRequest, isAllowedOrigin} = await import("../dist/security.js");
const {isRewritableContentType} = await import("../dist/url-rewrite.js");
const {injectionJs} = await import("../dist/mirror-controls.js");
const {EARLY_PATCH} = await import("../dist/browser-patch.js");
test.describe("server / reliability", () => {
test.after(() => rmSync(dir, {recursive:true, force:true}));
const item = (id) => ({id, title:id, createTime:"2026-01-01", updateTime:"2026-01-01", currentNodeId:null, gizmoId:null, isArchived:false});
test("pagination progresses through local boundary and explicit refresh fetches even with cached rows", async () => {
 let calls=[];
 const fetchPage=async opts => {calls.push(opts); return {items: !opts.archived && opts.offset < 200 ? Array.from({length:100}, (_,i)=>item(`remote-${opts.offset+i}`)) : []};};
 await syncConversationPage("account-pages",50,false,fetchPage);
 assert.equal(store.countConversations("account-pages"),100);
 assert.equal(hasRemoteHistory("account-pages"),true);
 await syncConversationPage("account-pages",150,false,fetchPage);
 assert.equal(calls[1].offset,100);
 await syncConversationPage("account-pages",250,false,fetchPage);
 assert.equal(hasRemoteHistory("account-pages"),false);
 const before=calls.length;
 await syncConversationPage("account-pages",50,true,fetchPage);
 assert.equal(calls.length,before+1);
 assert.equal(calls.at(-1).offset,0);
});
test("control routes require credentials and false query flags don't contact upstream", async () => {
 const app=await buildApp();
 try {
  assert.equal((await app.inject({method:"GET",url:"/api/session",headers:{host:"localhost"}})).statusCode,401);
  const headers={host:"localhost",authorization:"Bearer test-control-key"};
  const list=await app.inject({method:"GET",url:"/api/conversations?sync=false&resync=false",headers});
  assert.equal(list.statusCode,200,list.body);
  assert.equal((await app.inject({method:"GET",url:"/api/conversations?sync=garbage",headers})).statusCode,400);
  assert.equal((await app.inject({method:"GET",url:"/api/session",headers:{...headers,origin:"http://localhost:9999"}})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:"/v1/chat/completions",headers,payload:{model:"model-wm",messages:[{role:"user",content:"hello"}],stream:true}})).statusCode,400);
 } finally {await app.close();}
});
test("browser session and complete origins gate control access", () => {
 assert.equal(authorizedLocalRequest({cookie:controlCookie()}),true);
 assert.equal(authorizedLocalRequest({cookie:"mirror_control=wrong"}),false);
 assert.equal(isAllowedOrigin("http://localhost:9000","localhost:8787"),false);
 assert.equal(isAllowedOrigin("http://localhost:8787","localhost:8787"),true);
});
test("event streams are never text-rewritten and browser assets parse without telemetry init", () => {
 assert.equal(isRewritableContentType("text/event-stream; charset=utf-8"),false);
 new Function(injectionJs);
 new Function(EARLY_PATCH.replace(/^<script>/, "").replace(/<\/script>$/, ""));
 assert.equal(EARLY_PATCH.includes("dd.init("),false);
});
test("instruction snapshots round-trip and session revisions invalidate stale work", () => {
 const c=store.createConversation({model:"auto"});
 store.saveInstructions(c.id,[{role:"system",content:"Saved instructions"},{role:"user",content:"not instructions"}]);
 assert.deepEqual(store.getInstructions(c.id),[{role:"system",content:"Saved instructions"}]);
 const revision=store.getSessionRevision();
 store.clearSession();
 assert.throws(()=>store.assertSessionRevision(revision),/Session changed/);
});
});
