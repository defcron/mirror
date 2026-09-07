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

test('proxy waits for drain when the reply socket reports backpressure, then resumes pumping chunks',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mirror-proxy-stream-backpressure-'));process.env.MIRROR_DATA_DIR=dir;
 const {proxyChatGpt}=await import('../dist/proxy.js');const original=globalThis.fetch;
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 const writes=[];let writeReturn=false;const raw=new EventEmitter();Object.assign(raw,{destroyed:false,writeHead(){},write(buffer){writes.push(Buffer.from(buffer).toString());return writeReturn;},end(){this.writableEnded=true;}});
 const reply={raw,hijack(){},getHeader(){return undefined;}};
 const req={method:'GET',url:'/download',protocol:'http',headers:{host:'localhost',accept:'*/*'},raw:new EventEmitter(),log:{error(){}}};
 try{
  globalThis.fetch=async()=>new Response(stream,{headers:{'content-type':'application/octet-stream'}});
  const done=proxyChatGpt(req,reply);
  controller.enqueue(new TextEncoder().encode('chunk-one'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(writes,['chunk-one']);
  assert.equal(raw.writableEnded,undefined,'must still be waiting on drain, not finished');
  writeReturn=true;raw.emit('drain');
  await new Promise(resolve=>setImmediate(resolve));
  controller.enqueue(new TextEncoder().encode('chunk-two'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(writes,['chunk-one','chunk-two']);
  controller.close();await done;assert.equal(raw.writableEnded,true);
 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});

test('proxy stops pumping further chunks once the reply socket has been destroyed mid-stream',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mirror-proxy-stream-destroyed-'));process.env.MIRROR_DATA_DIR=dir;
 const {proxyChatGpt}=await import('../dist/proxy.js');const original=globalThis.fetch;
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 const writes=[];const raw=new EventEmitter();Object.assign(raw,{destroyed:false,writeHead(){},write(buffer){writes.push(Buffer.from(buffer).toString());return true;},end(){this.writableEnded=true;}});
 const reply={raw,hijack(){},getHeader(){return undefined;}};
 const req={method:'GET',url:'/download2',protocol:'http',headers:{host:'localhost',accept:'*/*'},raw:new EventEmitter(),log:{error(){}}};
 try{
  globalThis.fetch=async()=>new Response(stream,{headers:{'content-type':'application/octet-stream'}});
  const done=proxyChatGpt(req,reply);
  controller.enqueue(new TextEncoder().encode('chunk-one'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(writes,['chunk-one']);
  raw.destroyed=true;
  controller.enqueue(new TextEncoder().encode('chunk-two'));
  await done;
  assert.deepEqual(writes,['chunk-one'],'no further chunks may be written once the reply socket is destroyed');
 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
