// Build-blocking integration contract. Use the actual HTTP response as the
// next request's history, never a hand-written expected assistant reply.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assistantAddFrame, stubBackend } from "./helpers/backend.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-continuation-contract-"));
process.env.MIRROR_DATA_DIR = dir;
// These tests must not inherit production encryption/session settings.
delete process.env.MIRROR_STORE_KEY;
const { default: Fastify } = await import("fastify");
const store = await import("../dist/store.js");
const { registerOpenAiRoutes } = await import("../dist/openai.js");
const app = Fastify();
await registerOpenAiRoutes(app);
const address = await app.listen({ host: "127.0.0.1", port: 0 });
const localFetch = globalThis.fetch;
test.after(async () => {
  globalThis.fetch = localFetch;
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function readAnswer(response, stream) {
  assert.equal(response.status, 200);
  if (!stream) {
    const json = await response.json();
    assert.equal(json.error, undefined);
    return { id: response.headers.get("x-mirror-conversation-id"),
      text: json.choices[0].message.content, finish: json.choices[0].finish_reason };
  }
  const body = await response.text();
  let text = "", id, finish, done = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith(": mirror-conversation-id ")) id = line.slice(25).trim();
    if (!line.startsWith("data: ")) continue;
    if (line === "data: [DONE]") { done = true; continue; }
    const chunk = JSON.parse(line.slice(6));
    assert.equal(chunk.error, undefined, JSON.stringify(chunk.error));
    text += chunk.choices[0].delta.content ?? "";
    if (chunk.choices[0].finish_reason) finish = chunk.choices[0].finish_reason;
  }
  assert.ok(done && finish, "a partial/error stream is not a successful turn");
  return { id, text, finish };
}

const cases = [
  { name: "plain", text: "Complete answer", expected: "Complete answer" },
  { name: "token limit", text: "Complete answer", params: { max_tokens: 2 }, expected: "Complete answer" },
  { name: "completion token limit", text: "Complete answer", params: { max_tokens: 100, max_completion_tokens: 2 }, expected: "Complete answer" },
  { name: "stop", text: "Answer STOP hidden tail", params: { stop: "STOP" }, expected: "Answer STOP hidden tail" },
  { name: "split stop", text: "Answer STOP hidden tail", prefix: "Answer ST", params: { stop: "STOP" }, expected: "Answer STOP hidden tail" },
  { name: "unfinished stop prefix", text: "Answer ST", params: { stop: "STOP" }, expected: "Answer ST" },
  { name: "multiple assistant nodes", text: "Final answer", preamble: "Searching now.", expected: "Final answer", streamed: "Searching now.\n\nFinal answer" },
  { name: "replaced snapshot", prefix: "Draft", text: "Final answer", expected: "Final answer", streamed: "Draft\n\nFinal answer" },
  { name: "removed snapshot", prefix: "Draft", remove: true, text: "Final answer", expected: "Final answer", streamed: "Draft\n\nFinal answer" },
  { name: "missing status", noStatus: true, text: "Complete answer", expected: "Complete answer" },
  { name: "empty answer", text: "", expected: "" },
];

for (const tracking of ["history", "id-minimal", "id-full"]) {
  for (const transport of ["json", "stream", "mixed"]) {
    for (const fixture of cases) {
      test(`${tracking} / ${transport} / ${fixture.name}: turns 2 and 3 must continue`, { timeout: 10_000 }, async () => {
        const account = `${tracking}-${transport}-${fixture.name}`;
        store.saveVerifiedSession("synthetic-session-fixture", account, "synthetic-device");
        store.updateMintedToken("synthetic-access-fixture", Date.now() + 3_600_000, null);
        const sent = [];
        globalThis.fetch = stubBackend(account, { sent, turnFrames: (body, turn) => {
          const upstream = body.conversation_id ?? `upstream-${account}-${turn}`;
          const frames = [];
          if (fixture.preamble) frames.push(assistantAddFrame(upstream, `preamble-${turn}`, fixture.preamble));
          if (fixture.prefix) frames.push(assistantAddFrame(upstream, `answer-${turn}`, fixture.prefix));
          if (fixture.remove) frames.push({ p: "/message/content/parts/0", o: "remove", v: null });
          const final = assistantAddFrame(upstream, `answer-${turn}`, fixture.text);
          if (fixture.noStatus) delete final.v.message.status;
          frames.push(final, final,
            { type: "message_marker", event: "last", marker: "last_token", message_id: `answer-${turn}` }, "[DONE]");
          return frames;
        } });
        const history = [{ role: "system", content: "Keep these instructions." }];
        let firstId;
        for (let turn = 1; turn <= 3; turn++) {
          const stream = transport === "stream" || (transport === "mixed" && turn !== 2);
          const user = { role: "user", content: `Question ${turn}` };
          history.push(user);
          const response = await localFetch(`${address}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "auto", stream, ...fixture.params,
              messages: tracking === "id-minimal" && firstId ? [user] : history,
              ...(tracking !== "history" && firstId ? { metadata: { conversation_id: firstId } } : {}),
            }),
          });
          const answer = await readAnswer(response, stream);
          assert.equal(typeof answer.id, "string");
          firstId ??= answer.id;
          assert.equal(answer.id, firstId, `turn ${turn} spawned a different Mirror conversation`);
          assert.equal(store.countConversations(account), 1, `turn ${turn} created an unexpected thread/branch`);
          assert.equal(answer.text, stream ? fixture.streamed ?? fixture.expected : fixture.expected);
          assert.equal(answer.finish, fixture.finish ?? "stop");
          history.push({ role: "assistant", content: answer.text });
          const upstreamRequests = sent.filter(item => item.pathname.endsWith("/f/conversation"));
          assert.equal(upstreamRequests.length, turn, "one upstream send per requested turn");
          const request = upstreamRequests.at(-1).body;
          assert.equal(request.conversation_id ?? null, turn === 1 ? null : `upstream-${account}-1`,
            `turn ${turn} failed to retain the upstream thread`);
          assert.equal(request.parent_message_id, turn === 1 ? "client-created-root" : `answer-${turn - 1}`);
          if (turn > 1) assert.equal(request.messages[0].content.parts[0], user.content,
            "continuation must send one real user turn, not a replayed transcript");
          const stored = store.getConversation(firstId);
          assert.equal(stored.conversationId, `upstream-${account}-1`);
          assert.equal(stored.currentNodeId, `answer-${turn}`);
          assert.deepEqual(store.listMessages(firstId).map(({ role, content }) => ({ role, content })), history.slice(1),
            "reload must reproduce the logical transcript the client received");
          assert.equal(store.getOpenAiTranscript(firstId), store.fingerprintValue(history));
          assert.deepEqual(store.getInstructions(firstId), history.slice(0, 1));
        }
      });
    }
  }
}
