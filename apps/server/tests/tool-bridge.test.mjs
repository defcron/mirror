import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolDefinitions, toolBridgePrompt, parseToolBridgeAnswer } from '../dist/tool-bridge.js';

test.describe('server / tool bridge', () => {
  const tools = validateToolDefinitions([{ type: 'function', function: {
    name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } }]);
  test('prompts with tool definitions and prior tool results', () => {
    const prompt = toolBridgePrompt([{ role: 'tool', tool_call_id: 'call_1', content: 'file data' }], tools, 'auto');
    assert.match(prompt, /read_file/);
    assert.match(prompt, /file data/);
  });
  test('returns OpenAI shaped tool calls with JSON argument strings', () => {
    const answer = parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', tools, 'auto');
    assert.equal(answer.content, null);
    assert.match(answer.toolCalls[0].id, /^call_/);
    assert.equal(answer.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  });
  test('accepts a final answer after tool results', () => {
    assert.deepEqual(parseToolBridgeAnswer('{"content":"done"}', tools, 'auto'), { content: 'done' });
  });
  test('rejects unknown functions and invalid arguments', () => {
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"shell","arguments":{}}]}', tools, 'auto'), /unknown function/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /invalid function arguments/);
  });
});
