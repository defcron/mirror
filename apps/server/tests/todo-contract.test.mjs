import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stubBackend, assistantAddFrame } from "./helpers/backend.mjs";
const run = promisify(execFile);
const dir = mkdtempSync(path.join(tmpdir(), "mirror-contract-"));
process.env.MIRROR_DATA_DIR = path.join(dir, "data");
process.env.MIRROR_WEB_ORIGIN = " ";
process.env.MIRROR_API_KEY = "";
process.env.MIRROR_API_KEYS = " ";
process.env.OPENAI_API_KEY = "fixture-key";
const store = await import("../dist/store.js");
const { buildApp } = await import("../dist/index.js");
const { runChat } = await import("../dist/chat-service.js");
const { abortable, deadlineMs, turnDeadline } = await import("../dist/deadlines.js");
const { apiError, recentFailures, recordFailure } = await import("../dist/api-errors.js");
const egress = await import("../dist/egress.js");
const app = await buildApp();
const originalFetch = globalThis.fetch;
const auth = { host: "localhost", authorization: "Bearer fixture-key" };
function session() { store.saveVerifiedSession("synthetic-session", "fixture-account"); store.updateMintedToken("synthetic-access", Date.now() + 3600000, null); }
function post(messages, id, stream = false) { return app.inject({ method: "POST", url: "/v1/chat/completions", headers: auth, payload: { model: "auto", messages, stream, ...(id ? { metadata: { conversation_id: id } } : {}) } }); }
test.after(async () => { globalThis.fetch = originalFetch; await app.close(); rmSync(dir, { recursive: true, force: true }); });
test.afterEach(() => { globalThis.fetch = originalFetch; delete process.env.MIRROR_TURN_TIMEOUT_MS; delete process.env.MIRROR_IDLE_TIMEOUT_MS; });

test("minimal cm turns and full browser history retain instructions, hash, parent and edited branches", async () => {
  session(); const sent = []; globalThis.fetch = stubBackend("fixture-account", { sent });
  const first = await post([{ role: "system", content: "Be concise." }, { role: "user", content: "hello" }]);
  const id = first.headers["x-mirror-conversation-id"];
  assert.equal(first.statusCode, 200, first.body);
  const second = await post([{ role: "user", content: "cm followup" }], id, true);
  assert.match(second.body, /mirror-conversation-id/); assert.match(second.body, /\[DONE\]/);
  assert.deepEqual(store.getInstructions(id), [{ role: "system", content: "Be concise." }]);
  const history = () => [...store.getInstructions(id), ...store.listMessages(id).map(({ role, content }) => ({ role, content }))];
  assert.equal(store.getOpenAiTranscript(id), store.fingerprintValue(history()));
  const third = await post([...history(), { role: "user", content: "browser after reload" }], id);
  assert.equal(third.statusCode, 200, third.body);
  const turns = sent.filter(item => item.pathname.endsWith("/f/conversation"));
  assert.equal(turns[2].body.parent_message_id, "assistant-2");
  assert.equal(turns[2].body.messages[0].content.parts[0], "browser after reload");
  const edited = await post([...history().slice(0, 5), { role: "user", content: "edited third turn" }], id);
  assert.equal(edited.statusCode, 200, edited.body);
  const branches = await app.inject({ url: `/api/conversations/${id}/branches`, headers: auth });
  assert.equal(branches.json().items.length, 2);
  const saved = branches.json().items.find(item => item.id !== id);
  assert.equal(store.listMessages(saved.id).at(-1).content, "reply-3");
  const resumed = await post([{ role: "user", content: "resume saved branch" }], saved.id);
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body.parent_message_id, "assistant-3");
  assert.deepEqual(store.getInstructions(saved.id), [{ role: "system", content: "Be concise." }]);
});

test("public API compatibility preflight, errors, request IDs and allowlisted diagnostics", async () => {
  session(); globalThis.fetch = stubBackend("fixture-account");
  const preflight = await app.inject({ method: "OPTIONS", url: "/v1/models", headers: { host: "localhost", origin: "https://extension.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
  assert.equal(preflight.statusCode, 204);
  const models = await app.inject({ url: "/v1/models", headers: { ...auth, origin: "https://extension.example" } });
  assert.equal(models.statusCode, 200); assert.match(models.headers["access-control-expose-headers"], /x-request-id/);
  for (const [url, headers, expected] of [["/v1/models", { host: "localhost", origin: "https://extension.example" }, 401], ["/v1/absent", auth, 404]]) {
    const res = await app.inject({ url, headers }); assert.equal(res.statusCode, expected); assert.ok(res.json().error.code); assert.equal(res.json().error.request_id, res.headers["x-request-id"]);
  }
  const invalid = await post([], null); assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error.code, "invalid_request");
  globalThis.fetch = async () => { throw new Error("sensitive-upstream-payload"); };
  const failed = await post([{ role: "user", content: "test" }], "failed-stream", true);
  assert.match(failed.body, /upstream_failure/); assert.doesNotMatch(failed.body, /sensitive-upstream-payload|\[DONE\]/);
  const health = await app.inject({ url: "/api/diagnostics", headers: auth });
  assert.equal(health.json().api.reachable, true); assert.doesNotMatch(health.body, /synthetic-session|synthetic-access|sensitive-upstream-payload|prompt/);
  assert.equal(health.json().build.revision, "development");
  process.env.MIRROR_BUILD_REVISION = "abcdef0";
  globalThis.fetch = async () => new Response("warp=on"); await egress.verifyRequiredEgress();
  assert.match((await app.inject({ url: "/api/diagnostics", headers: auth })).json().nextAction, /Test model/);
  store.clearSession();
  assert.match((await app.inject({ url: "/api/diagnostics", headers: auth })).json().nextAction, /Save a session/);
  delete process.env.MIRROR_BUILD_REVISION;
  const cap = await app.inject({ url: "/v1/capabilities", headers: { ...auth, origin: "https://extension.example" } });
  assert.equal(cap.statusCode, 200); assert.ok(cap.json().fields.includes("messages"));
  for (const code of [400, 401, 403, 404, 409, 429, 500, 504]) assert.ok(apiError(code, "safe", "r").error.code);
  for (let i = 0; i < 25; i++) recordFailure("test_category", `request-${i}`);
  assert.equal(recentFailures().length, 20);
});

test("local search and portable exports enforce account ownership and exclude raw attachment data", async () => {
  session();
  const c = store.createConversation({ id: "export-fixture", model: "auto", title: "Archive fixture", accountId: "fixture-account" });
  store.saveInstructions(c.id, [{ role: "system", content: "saved instructions" }]);
  store.addMessage({ conversationId: c.id, role: "user", content: "needle", status: "done", upstreamNodeId: null, events: [{ kind: "raw", raw: "secret-raw" }], attachments: [{ fileId: "file-1", fileName: "image.png", mimeType: "image/png", raw: { signed_url: "secret-signed" } }] });
  store.addMessage({ conversationId: c.id, role: "assistant", content: "answer", status: "done", upstreamNodeId: "node", events: [] });
  store.createConversation({ model: "auto", title: "needle", accountId: "other" });
  const search = await app.inject({ url: "/api/conversations/search?q=needle", headers: auth });
  assert.deepEqual(search.json().items.map(item => item.id), [c.id]);
  for (const format of ["json", "markdown"]) for (const flags of ["", "&attachments=true&metadata=true"]) {
    const res = await app.inject({ url: `/api/conversations/${c.id}/export?format=${format}${flags}`, headers: auth });
    assert.equal(res.statusCode, 200, res.body); assert.doesNotMatch(res.body, /secret-raw|secret-signed/);
    if (flags) assert.match(res.body, /file-1/); else assert.doesNotMatch(res.body, /file-1|upstreamNodeId/);
  }
  const branch = await app.inject({ url: `/api/conversations/${c.id}/branches`, headers: auth }); assert.equal(branch.json().items.length, 1);
  for (const route of ["export", "branches"]) assert.equal((await app.inject({ url: `/api/conversations/missing/${route}`, headers: auth })).statusCode, 404);
  // With no session saved at all, every insights route falls back to the
  // synthetic "default" account rather than throwing - it just sees none
  // of this account-scoped fixture data.
  store.clearSession();
  try {
    const noSession = await app.inject({ url: "/api/conversations/search?q=needle", headers: auth });
    assert.equal(noSession.statusCode, 200, noSession.body);
    assert.deepEqual(noSession.json().items, []);
  } finally {
    session();
  }
});

test("deadlines abort hung calls, preserve failed rows and release queued conversation locks", async () => {
  session(); process.env.MIRROR_IDLE_TIMEOUT_MS = "25"; process.env.MIRROR_TURN_TIMEOUT_MS = "1000";
  globalThis.fetch = async () => new Promise(() => {});
  const first = post([{ role: "user", content: "hung" }], "deadline");
  const queued = post([{ role: "user", content: "queued" }], "deadline");
  for (const response of await Promise.all([first, queued])) assert.equal(response.statusCode, 504, response.body);
  assert.equal(store.listMessages("deadline").at(-1).status, "error");
  delete process.env.MIRROR_IDLE_TIMEOUT_MS;
  globalThis.fetch = stubBackend("fixture-account");
  assert.equal((await post([{ role: "user", content: "recover" }], "deadline")).statusCode, 200);
  // Even a signal that is already aborted before runChat does anything
  // still leaves a coherent local record: chat-service.test.mjs's "an
  // aborted turn is recorded as stopped, not errored" is the deliberate,
  // specific test for this contract - the conversation/message rows are
  // created up front so a cancelled turn is visible as "stopped" (not
  // silently dropped, and not shown as an error).
  const before = store.countConversations("fixture-account");
  await assert.rejects(runChat({ prompt: "already aborted", signal: AbortSignal.abort() }), (error) => {
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(store.countConversations("fixture-account"), before + 1);
  const controller = new AbortController();
  const work = abortable(new Promise(() => {}), controller.signal); controller.abort(new Error("cancelled")); await assert.rejects(work, /cancelled/);
  assert.equal(await abortable(Promise.resolve("ok"), new AbortController().signal), "ok");
  for (const value of [undefined, "", " ", "0", "no", "-1", "99999999999"]) assert.equal(deadlineMs(value, 42), 42);
  assert.equal(deadlineMs("50", 42), 50);
  process.env.MIRROR_TURN_TIMEOUT_MS = "10";
  const timed = new AbortController(); const d = turnDeadline(timed); d.touch();
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(timed.signal.reason.statusCode, 504); d.close();
});

function isRunnableOnThisPlatform(binary) {
  // A cm binary can be present on disk (built by the user on their own
  // machine, e.g. a macOS Mach-O executable) yet not runnable in whatever
  // sandbox happens to run this suite (a Linux container). Rather than
  // pattern-matching a spawn failure's stderr text (fragile across shells
  // and OSes), read the file's own magic bytes: only a real ELF binary
  // (0x7f 'E' 'L' 'F') can execute on Linux. Anything else - Mach-O, PE,
  // a stale placeholder - means "skip", not "cm is broken".
  if (process.platform !== "linux") return false;
  const fd = openSync(binary, "r");
  try {
    const magic = Buffer.alloc(4);
    readSync(fd, magic, 0, 4, 0);
    return magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally { closeSync(fd); }
}

test("actual cm subprocesses interoperate across streamed and JSON turns with isolated state", async t => {
  const binary = path.resolve("../cm/target/debug/cm");
  if (!existsSync(binary)) return t.skip("Build cm to enable the sibling-client contract test");
  if (!isRunnableOnThisPlatform(binary)) return t.skip("cm binary on disk is not runnable on this platform (likely built for a different OS/arch)");
  session(); const sent = []; globalThis.fetch = stubBackend("fixture-account", { sent });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  const env = { ...process.env, CM_STATE_DIR: path.join(dir, "cm"), CM_BASE_URL: address, CM_API_KEY: "fixture-key", CM_MODEL: "auto" };
  const first = await run(binary, ["--new", "--system", "Keep fixture instructions", "hello"], { cwd: dir, env });
  assert.match(first.stdout, /reply-1/);
  const state = () => JSON.parse(readFileSync(path.join(env.CM_STATE_DIR, "state.json"), "utf8")).threads.default.conversation_id;
  const id = state();
  await run(binary, ["followup"], { cwd: dir, env }); assert.equal(state(), id);
  await run(binary, ["--no-stream", "third"], { cwd: dir, env }); assert.equal(state(), id);
  assert.equal(store.listMessages(id).length, 6);
  assert.equal(store.getInstructions(id)[0].content, "Keep fixture instructions");
  assert.equal(sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body.parent_message_id, "assistant-2");
});
