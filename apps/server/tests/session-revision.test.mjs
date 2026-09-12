import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
test.describe("server / session-revision", () => {
test('a pending refresh cannot write credentials into a replacement session',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'mirror-session-revision-'));process.env.MIRROR_DATA_DIR=dir;
 const store=await import('../dist/store.js');const auth=await import('../dist/auth.js');const original=globalThis.fetch;
 let release;const gate=new Promise(resolve=>{release=resolve;});
 try{
  store.saveVerifiedSession('old-session','old-account');
  globalThis.fetch=async()=>{await gate;return Response.json({accessToken:'old-access'});};
  const pending=auth.getValidCredentials();const rejected=assert.rejects(pending,/Session changed/);
  store.saveVerifiedSession('new-session','new-account');release();await rejected;
  assert.equal(store.getSession().sessionToken,'new-session');assert.equal(store.getSession().cachedAccessToken,undefined);
 }finally{globalThis.fetch=original;rmSync(dir,{recursive:true,force:true});}
});
});
