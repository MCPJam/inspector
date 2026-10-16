import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeTurn, runUserTesting } from '../hosted-harness-user-testing-canary.mjs';

const stream = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''));
const chunks = [
  { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: 'done' },
  { type: 'tool-input-available', toolCallId: 'call', toolName: 'fixture', input: { exact: true } },
  { type: 'tool-output-available', toolCallId: 'call', output: 'result' }, { type: 'finish' },
];

test('stream continuation retains actual text, tool inputs and results', async () => {
  const message = await consumeTurn(stream(chunks));
  assert.equal(message.parts[0].text, 'done');
  assert.deepEqual(message.parts[1], { type: 'dynamic-tool', toolCallId: 'call', toolName: 'fixture',
    input: { exact: true }, output: 'result', state: 'output-available' });
  await assert.rejects(consumeTurn(stream(chunks.slice(0, -1))), /incomplete/);
  await assert.rejects(consumeTurn(stream([{ type: 'tool-approval-request' }])), /incomplete/);
});

test('User Testing redeems the study then sends two real scenario requests and reads persisted evidence', async () => {
  const requests = [];
  const config = { projectId: 'project', webUrl: 'https://staging.test', clients: [{ harness: 'codex' }] };
  const result = await runUserTesting(config, 'session', { codex: 'study-token' }, async args =>
    args[2] === 'show' ? { messages: [] } : { turns: [] }, async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('/redeem')) return Response.json({ scenarioId: 'study', projectId: 'project', accessVersion: 4,
      bootstrap: { modelId: 'model', servers: [{ serverId: 'server' }] } });
    return stream(chunks);
  });
  assert.deepEqual(requests.map(request => request.path), ['/api/web/scenarios/redeem', '/api/web/chat-v2', '/api/web/chat-v2']);
  assert.equal(requests[2].body.chatSessionId, requests[1].body.chatSessionId);
  assert.equal(requests[2].body.messages.length, 3);
  assert.equal(requests[2].body.messages[1].parts[1].output, 'result');
  assert.equal(result[0].status, 'inconclusive');
  assert.equal(result[0].reason, 'missing_two_turns');
});

test('missing first-party credentials produce an explicit not-run result', async () => {
  const results = await runUserTesting({ clients: [{ harness: 'codex' }] }, undefined, {}, () => assert.fail('no CLI'));
  assert.equal(results[0].status, 'not_run');
});
