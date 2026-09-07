import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, copyFileSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
const [command, argument, confirmation] = process.argv.slice(2);
const dir = path.resolve(process.env.MIRROR_DATA_DIR ?? ".data");
const dbPath = path.join(dir, "mirror.db");
if (command === "backup" && argument) {
  const target = path.resolve(argument);
  mkdirSync(target, {mode:0o700}); // Refuse overwriting an existing backup.
  const db = new DatabaseSync(dbPath, {readOnly:true});
  try { await backup(db, path.join(target,"mirror.db")); } finally { db.close(); }
  chmodSync(path.join(target,"mirror.db"), 0o600);
  if (!process.env.MIRROR_STORE_KEY && existsSync(path.join(dir,"master.key"))) copyFileSync(path.join(dir,"master.key"), path.join(target,"master.key"));
  if (existsSync(path.join(target,"master.key"))) chmodSync(path.join(target,"master.key"), 0o600);
  console.log("Backup saved. Protect this directory: it includes conversation data and may include the credential encryption key.");
} else if (command === "restore" && argument && confirmation === "--offline") {
  if (existsSync(dbPath)) throw new Error("Restore requires an empty target directory; keep the old directory as a recovery copy.");
  const source = path.resolve(argument);
  const db = new DatabaseSync(path.join(source,"mirror.db"), {readOnly:true});
  try { if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Backup integrity check failed"); db.prepare("SELECT count(*) FROM conversations").get(); } finally { db.close(); }
  mkdirSync(dir, {recursive:true, mode:0o700});
  copyFileSync(path.join(source,"mirror.db"), dbPath); chmodSync(dbPath,0o600);
  if (existsSync(path.join(source,"master.key"))) { copyFileSync(path.join(source,"master.key"),path.join(dir,"master.key")); chmodSync(path.join(dir,"master.key"),0o600); }
  console.log("Restored. If the backup used MIRROR_STORE_KEY, supply the same key before startup.");
} else if (command === "prune" && /^\d+$/.test(argument ?? "") && Number(argument) > 0 && ["--offline", "--dry-run"].includes(confirmation)) {
  const preview = confirmation === "--dry-run";
  const db = new DatabaseSync(dbPath, { readOnly: preview });
  try {
    db.exec("PRAGMA foreign_keys=ON");
    const before = new Date(Date.now() - Number(argument) * 86400000).toISOString();
    const count = (sql) => db.prepare(sql).get(before).n;
    const report = {
      dryRun: preview, cutoff: before, retentionDays: Number(argument),
      conversations: count("SELECT count(*) AS n FROM conversations WHERE updated_at < ?"),
      messages: count("SELECT count(*) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)"),
      events: count("SELECT coalesce(sum(json_array_length(events_json)),0) AS n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)"),
      instructions: count("SELECT count(*) AS n FROM conversation_instructions WHERE conversation_id IN (SELECT id FROM conversations WHERE updated_at < ?)"),
      filesRemoved: 0,
      fileRecordsRetained: db.prepare("SELECT count(*) AS n FROM files").get().n,
      policy: "Delete local conversations older than cutoff, cascading messages, instructions and transcript/context hashes. Retain session, sync cursors, all file records, and upstream history/assets. No secure-erasure guarantee.",
    };
    if (!preview) {
      db.prepare("DELETE FROM conversations WHERE updated_at < ?").run(before);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
    }
    console.log(JSON.stringify(report, null, 2));
  } finally { db.close(); }
} else throw new Error("Usage: npm run storage -- backup NEW_DIRECTORY | restore BACKUP_DIRECTORY --offline | prune DAYS --dry-run | prune DAYS --offline. Stop Mirror before restore/prune deletion.");
