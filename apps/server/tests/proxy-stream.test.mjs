import assert from 'node:assert/strict';
import test from 'node:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test('proxy delivers the first SSE event before upstream EOF',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mirror-proxy-stream-'));process.env.MIRROR_DATA_DIR=dir;
 const {proxyChatGpt}=await import('../dist/proxy.js');const original=globalThis.fetch;
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 const writes=[];const raw=new EventEmitter();Object.assign(raw,{writeHead(){},write(buffer){writes.push(Buffer.from(buffer).toString());return true;},end(){this.writableEnded=true;}});
 const reply={raw,hijack(){},getHeader(){return undefined;}};
 const req={method:'GET',url:'/events',protocol:'http',headers:{host:'localhost',accept:'text/event-stream'},raw:new EventEmitter(),log:{error(){}}};
 try{
  globalThis.fetch=async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}});
  const done=proxyChatGpt(req,reply);
  controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(writes,['data: first\n\n']);assert.equal(raw.writableEnded,undefined);
  controller.close();await done;assert.equal(raw.writableEnded,true);
 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
