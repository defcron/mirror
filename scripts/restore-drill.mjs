import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only synthetic data in an owned temporary directory; never open configured storage.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(path.join(tmpdir(), "mirror-restore-drill-"));
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (args, env) => execFileSync(process.execPath, args, {
  cwd: project, env, stdio: "pipe", timeout: 60_000,
});
const seed = `
  const s = await import('./apps/server/dist/store.js');
  s.saveVerifiedSession('synthetic-restore-session', 'fixture-account', 'fixture-device');
  const c = s.createConversation({model:'auto', accountId:'fixture-account', title:'Restore fixture'});
  s.updateConversation({...c, conversationId:'fixture-upstream', currentNodeId:'fixture-parent'});
  s.saveInstructions(c.id, [{role:'system', content:'Fixture instructions'}]);
  s.addMessage({conversationId:c.id, upstreamNodeId:'fixture-parent', role:'assistant', content:'Fixture answer', status:'done', events:[]});
`;
const verify = `
  const assert = (await import('node:assert/strict')).default;
  const s = await import('./apps/server/dist/store.js');
  assert.equal(s.getSession().sessionToken, 'synthetic-restore-session');
  const [c] = s.listConversations('fixture-account');
  assert.equal(c.conversationId, 'fixture-upstream');
  assert.equal(c.currentNodeId, 'fixture-parent');
  assert.deepEqual(s.getInstructions(c.id), [{role:'system', content:'Fixture instructions'}]);
  assert.equal(s.listMessages(c.id)[0].content, 'Fixture answer');
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(process.env.MIRROR_DATA_DIR + '/mirror.db', {readOnly:true});
  const {DATABASE_SCHEMA_VERSION} = await import('./apps/server/dist/schema.js');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, DATABASE_SCHEMA_VERSION);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  db.close();
`;
try {
  const modes = [];
  for (const mode of ["generated-key", "supplied-key"]) {
    const source = path.join(root, mode);
    const target = path.join(root, mode + "-restored");
    const backup = path.join(root, mode + "-backup");
    const env = {...process.env, MIRROR_DATA_DIR:source};
    delete env.MIRROR_STORE_KEY;
    if (mode === "supplied-key") env.MIRROR_STORE_KEY = randomBytes(32).toString("hex");
    run(["--input-type=module", "-e", seed], env);
    const original = digest(path.join(source, "mirror.db"));
    run(["scripts/storage.mjs", "backup", backup], env);
    assert.equal(existsSync(path.join(backup, "master.key")), mode === "generated-key");
    const restoredEnv = {...env, MIRROR_DATA_DIR:target};
    run(["scripts/storage.mjs", "restore", backup, "--offline"], restoredEnv);
    run(["--input-type=module", "-e", verify], restoredEnv);
    assert.equal(digest(path.join(source, "mirror.db")), original);
    assert.throws(() => run(["scripts/storage.mjs", "restore", backup, "--offline"], restoredEnv));
    const wrongKeyEnv = {...restoredEnv, MIRROR_STORE_KEY:randomBytes(32).toString("hex")};
    assert.throws(() => run(["--input-type=module", "-e", verify], wrongKeyEnv));
    modes.push({mode, integrity:true, credentialsDecrypted:true, historyAndParentPreserved:true, sourceUnchanged:true, overwriteRejected:true, wrongKeyRejected:true});
  }
  console.log(JSON.stringify({kind:"mirror-offline-restore-drill", synthetic:true, liveContinuationVerified:false, modes}, null, 2));
} catch {
  // Child failures may carry runtime environment details; keep the report bounded.
  console.error("Offline restore drill failed. Run the storage regression tests for diagnostics.");
  process.exitCode = 1;
} finally {
  rmSync(root, {recursive:true, force:true});
}
