// Optional, opt-in integration test: drives the real `cm` CLI (a separate
// Rust project) as a subprocess against a live Mirror server, to confirm the
// actual compiled client and Mirror's API agree on conversation continuity
// across streamed and JSON turns. Mirror's own server-side contracts for
// this behavior are already exercised, independently of this file, by
// todo-contract.test.mjs, conversation-continuation.test.mjs and
// chat-service.test.mjs - this file adds black-box confidence on top of
// that, it does not cover any source line those miss.
//
// Never install/build cm or require its Rust toolchain here - point
// CM_TEST_BINARY at an already-built binary (or have `cm`/`cm.exe` on PATH)
// to run this. Deliberately excluded from the `*.test.mjs` glob that
// `npm run test:unit` / `npm run coverage` / CI use, so a missing binary
// never shows up as a skip in the normal test run:
//
//   CM_TEST_BINARY=/path/to/cm node --test apps/server/tests/cm-integration.mjs
//
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stubBackend } from "./helpers/backend.mjs";

const run = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), "mirror-cm-integration-"));
process.env.MIRROR_DATA_DIR = path.join(dir, "data");
process.env.MIRROR_WEB_ORIGIN = " ";
process.env.MIRROR_API_KEY = "";
process.env.MIRROR_API_KEYS = " ";
process.env.OPENAI_API_KEY = "fixture-key";
const store = await import("../dist/store.js");
const { buildApp } = await import("../dist/index.js");
const app = await buildApp();
const originalFetch = globalThis.fetch;
function session() { store.saveVerifiedSession("synthetic-session", "fixture-account"); store.updateMintedToken("synthetic-access", Date.now() + 3600000, null); }

test.after(async () => { globalThis.fetch = originalFetch; await app.close(); rmSync(dir, { recursive: true, force: true }); });

test("actual cm subprocesses interoperate across streamed and JSON turns with isolated state", { timeout: 100_000 }, async t => {
  const binary = process.env.CM_TEST_BINARY
    ? path.resolve(process.env.CM_TEST_BINARY)
    : (process.env.PATH ?? "").split(path.delimiter)
      .map(directory => path.join(directory, process.platform === "win32" ? "cm.exe" : "cm"))
      .find(candidate => existsSync(candidate));
  if (!binary || !existsSync(binary)) return t.skip("Optional cm binary is missing; set CM_TEST_BINARY to an existing executable to enable this integration test");
  session(); const sent = []; globalThis.fetch = stubBackend("fixture-account", { sent });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const env = { ...process.env, CM_STATE_DIR: path.join(dir, "cm"), CM_BASE_URL: address, CM_API_KEY: "fixture-key", CM_MODEL: "auto" };
  const first = await run(binary, ["--new", "--system", "Keep fixture instructions", "hello"], { cwd: dir, env, timeout: 30_000 });
  assert.match(first.stdout, /reply-1/);
  const state = () => JSON.parse(readFileSync(path.join(env.CM_STATE_DIR, "state.json"), "utf8")).threads.default.conversation_id;
  const id = state();
  await run(binary, ["followup"], { cwd: dir, env, timeout: 30_000 }); assert.equal(state(), id);
  await run(binary, ["--no-stream", "third"], { cwd: dir, env, timeout: 30_000 }); assert.equal(state(), id);
  assert.equal(store.listMessages(id).length, 6);
  assert.equal(store.getInstructions(id)[0].content, "Keep fixture instructions");
  assert.equal(sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body.parent_message_id, "assistant-2");
});
