import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { stubBackend } from "./helpers/backend.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-stream-lifecycle-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const { registerOpenAiRoutes } = await import("../dist/openai.js");
const nativeFetch = globalThis.fetch;
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("a seventh full-history turn sends parseable keepalives while upstream is silent, then continues the same parent", { timeout: 5000 }, async t => {
  store.saveVerifiedSession("fixture-session", "heartbeat-account");
  store.updateMintedToken("fixture-access", Date.now() + 3600000, null);
  const sent = [];
  const backend = stubBackend("heartbeat-account", { sent });
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let pause = false;
  globalThis.fetch = async (url, init) => {
    if (pause && String(url).endsWith("/me")) {
      entered.resolve();
      await gate.promise;
    }
    return backend(url, init);
  };
  const app = Fastify();
  await registerOpenAiRoutes(app);
  let reader;
  try {
    const history = [];
    let id;
    for (let turn = 1; turn <= 6; turn++) {
      history.push({ role: "user", content: `turn ${turn}` });
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: history } });
      assert.equal(response.statusCode, 200, response.body);
      id ??= response.headers["x-mirror-conversation-id"];
      assert.equal(response.headers["x-mirror-conversation-id"], id);
      history.push(response.json().choices[0].message);
    }
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    pause = true;
    t.mock.timers.enable({ apis: ["setInterval"] });
    const response = await nativeFetch(`${address}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [...history, { role: "user", content: "seventh turn with apostrophes, (parentheses), and tool call intent" }], stream: true }),
    });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value);
    await entered.promise;
    // Model the extension's data-event -> runtime.Port.postMessage path.
    // SSE comments do not reach that callback and cannot keep its worker alive.
    for (let interval = 0; interval < 4; interval++) {
      t.mock.timers.tick(10000);
      const heartbeat = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("No SSE data heartbeat during upstream preparation")), 100)),
      ]);
      const text = decoder.decode(heartbeat.value);
      const event = JSON.parse(text.trim().slice("data: ".length));
      assert.equal(event.object, "chat.completion.chunk");
      assert.deepEqual(event.choices, [{ index: 0, delta: { content: "" }, finish_reason: null }]);
      output += text;
    }
    gate.resolve();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value);
    }
    assert.match(output, /reply-7/);
    assert.match(output, /\[DONE\]/);
    assert.match(output, new RegExp(`mirror-conversation-id ${id}`));
    const lastTurn = sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body;
    assert.equal(lastTurn.parent_message_id, "assistant-6");
    assert.equal(lastTurn.conversation_id, "upstream-1");
    assert.equal(store.listMessages(id).length, 14);
    assert.equal(store.listMessages(id).at(-1).content, "reply-7");
    // A finished request must not leave a timer writing into the closed socket.
    t.mock.timers.tick(30000);
  } finally {
    gate.resolve();
    await reader?.cancel();
    t.mock.timers.reset();
    globalThis.fetch = nativeFetch;
    await app.close();
  }
});

for (const failure of ["idle deadline", "heartbeat write"]) {
  test(`silent streams terminate on ${failure} and release the conversation for retry`, { timeout: 5000 }, async t => {
    const account = `heartbeat-${failure}`;
    store.saveVerifiedSession("fixture-session", account);
    store.updateMintedToken("fixture-access", Date.now() + 3600000, null);
    process.env.MIRROR_IDLE_TIMEOUT_MS = "100";
    const entered = Promise.withResolvers();
    let upstreamSignal;
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal;
      entered.resolve();
      return new Promise(() => {});
    };
    let failWrite = false;
    const app = Fastify();
    app.addHook("onRequest", async (_req, reply) => {
      const write = reply.raw.write;
      reply.raw.write = function (...args) {
        if (failWrite) {
          failWrite = false;
          throw new Error("fixture write failure");
        }
        return write.apply(this, args);
      };
    });
    await registerOpenAiRoutes(app);
    let reader;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      t.mock.timers.enable({ apis: ["setInterval"] });
      const response = await nativeFetch(`${address}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "silent turn" }], metadata: { conversation_id: failure }, stream: true }),
      });
      reader = response.body.getReader();
      await reader.read();
      await entered.promise;
      failWrite = failure === "heartbeat write";
      t.mock.timers.tick(10000);
      let output = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      assert.match(output, failure === "idle deadline" ? /deadline_exceeded/ : /upstream_failure/);
      assert.doesNotMatch(output, /\[DONE\]|fixture write failure/);
      assert.equal(upstreamSignal.aborted, true);
      assert.equal(store.listMessages(failure).at(-1).status, "error");
      t.mock.timers.tick(30000);
      globalThis.fetch = stubBackend(account);
      const retry = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: [{ role: "user", content: "retry" }], metadata: { conversation_id: failure } } });
      assert.equal(retry.statusCode, 200, retry.body);
    } finally {
      await reader?.cancel();
      t.mock.timers.reset();
      delete process.env.MIRROR_IDLE_TIMEOUT_MS;
      globalThis.fetch = nativeFetch;
      await app.close();
    }
  });
}
