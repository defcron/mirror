import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
test('backup and restore preserve WAL-committed data; retention preserves credentials',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'mirror-maintenance-'));
 const source=path.join(root,'source'),restored=path.join(root,'restored'),backup=path.join(root,'backup');
 const run=(args,dir)=>execFileSync(process.execPath,['scripts/storage.mjs',...args],{cwd:process.cwd(),env:{...process.env,MIRROR_DATA_DIR:dir},stdio:'pipe'});
 try{
  execFileSync(process.execPath,['--input-type=module','-e',`const s=await import('./apps/server/dist/store.js');s.saveVerifiedSession('synthetic-token','test');const c=s.createConversation({model:'auto',accountId:'test'});s.saveInstructions(c.id,[{role:'system',content:'saved'}]);`],{env:{...process.env,MIRROR_DATA_DIR:source}});
  run(['backup',backup],source);run(['restore',backup,'--offline'],restored);
  const db=new DatabaseSync(path.join(restored,'mirror.db'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversation_instructions').get().n,1);
  db.exec("UPDATE conversations SET updated_at='2000-01-01'");db.close();
  // A --dry-run preview reports what pruning would remove without
  // actually touching the database - the conversation must still be
  // there afterward, and only --offline (below) actually deletes it.
  const preview=JSON.parse(String(run(['prune','90','--dry-run'],restored)));
  assert.equal(preview.dryRun,true);
  assert.equal(preview.conversations,1);
  assert.equal(preview.instructions,1);
  const beforeDelete=new DatabaseSync(path.join(restored,'mirror.db'));
  assert.equal(beforeDelete.prepare('SELECT count(*) AS n FROM conversations').get().n,1);
  beforeDelete.close();
  run(['prune','90','--offline'],restored);
  const check=new DatabaseSync(path.join(restored,'mirror.db'));
  assert.equal(check.prepare('SELECT count(*) AS n FROM conversations').get().n,0);
  assert.equal(check.prepare("SELECT count(*) AS n FROM settings WHERE key='session'").get().n,1);check.close();
  assert.throws(()=>run(['restore',backup,'--offline'],restored));
 }finally{rmSync(root,{recursive:true,force:true});}
});
