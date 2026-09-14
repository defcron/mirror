import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase, databaseSchemaVersion, DATABASE_SCHEMA_VERSION } from "../dist/schema.js";

test.describe("server / schema", () => {
  test("fresh databases get a numbered baseline and repeated startup preserves data", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateDatabase(db);
      assert.equal(databaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
      db.exec("INSERT INTO settings VALUES ('fixture', 'retained', 'today')");
      migrateDatabase(db);
      assert.equal(db.prepare("SELECT value FROM settings").get().value, "retained");
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally { db.close(); }
  });

  test("a failed legacy upgrade rolls back schema changes and version together", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // A damaged legacy messages table makes index creation fail midway.
      db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY)");
      assert.throws(() => migrateDatabase(db), /no such column/);
      assert.equal(databaseSchemaVersion(db), 0);
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name), ["messages"]);
      db.exec("DROP TABLE messages");
      migrateDatabase(db);
      assert.equal(databaseSchemaVersion(db), DATABASE_SCHEMA_VERSION);
    } finally { db.close(); }
  });

  test("newer and invalid database versions are rejected without modification", () => {
    for (const version of [DATABASE_SCHEMA_VERSION + 1, -1]) {
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(`PRAGMA user_version = ${version}`);
        assert.throws(() => migrateDatabase(db), /Unsupported database schema/);
        assert.equal(databaseSchemaVersion(db), version);
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master").get().n, 0);
      } finally { db.close(); }
    }
  });
});
