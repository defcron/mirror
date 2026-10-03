import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-tool-bridge-'));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = 'fixture-mirror-key';
const store = await import('../dist/store.js');
store.saveVerifiedSession('fixture-session', 'tool-bridge-test');
store.updateMintedToken('fixture-access', Date.now() + 3600000, null);
const { buildApp } = await import('../dist/index.js');
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

test.describe('server / tool bridge route', () => {
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  async function request(stream, text, messages = [{ role: 'user', content: 'Read a.txt' }]) {
    const app = await buildApp({ worker: true });
    test.mock.method(globalThis, 'fetch', stubBackend('tool-bridge-test'));
    test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', async () => ({
      conversationId: 'upstream-test', messageId: 'assistant-test', userMessageId: 'user-test', status: 'done', events: [], text,
    }));
    try {
      return await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-mirror-key' },
        payload: { messages, tools, stream, stream_options: { include_usage: true }, reasoning_effort: 'high' } });
    } finally { test.mock.restoreAll(); await app.close(); }
  }
  test('returns a nonstreamed function request', async () => {
    const response = await request(false, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}');
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(response.json().choices[0].message.tool_calls[0].function.name, 'read_file');
  });
  test('streams a function request and accepts the following tool result', async () => {
    const response = await request(true, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}');
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"finish_reason":"tool_calls"/);
    assert.match(response.body, /data: \[DONE\]/);
    const next = await request(false, '{"content":"The file says hello."}', [
      { role: 'user', content: 'Read a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
    ]);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().choices[0].message.content, 'The file says hello.');
  });
});
