import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, verifyTurn, runCanary } from '../hosted-harness-chat-canary.mjs';
const client = { harness: 'codex', clientId: 'client', modelId: 'model', fixtureServerId: 'server', fixtureToolName: 'fixture', fixtureInput: { repo: 'fixture' } };
const probe = { file: 'file.txt', nonce: 'native-content' };
const turn = () => ({ sessionId: 'public', turnId: 'first', persisted: { outcome: 'saved' },
  execution: { engine: 'harness:codex', venue: 'hosted', runtimeVersion: '0.149.1', sessionId: 'runtime', turnId: 'r1' },
  trace: { spans: [{ category: 'tool', toolOrigin: 'native', status: 'ok', toolCallId: 'w' }, { category: 'tool', toolOrigin: 'native', status: 'ok', toolCallId: 'n' },
    { toolOrigin: 'mcp', serverId: 'server', toolName: 'fixture', wireCorroborated: true, evidenceStatus: 'complete', toolCallId: 'm' }] },
  toolCalls: [{ toolCallId: 'w', status: 'ok', input: { path: 'file.txt', content: 'native-content' }, output: 'ok' },
    { toolCallId: 'n', status: 'ok', input: { path: 'file.txt' }, output: 'native-content' },
    { toolCallId: 'm', status: 'ok', input: { repo: 'fixture' }, output: 'ok' }] });
test('requires observed native and exact wire-correlated MCP evidence', () => {
  assert.equal(verifyTurn(turn(), client, probe).venue, 'hosted');
  const uncorroborated = turn(); uncorroborated.trace.spans[2].wireCorroborated = false;
  assert.throws(() => verifyTurn(uncorroborated, client, probe), /exact_mcp/);
  const invented = turn(); invented.toolCalls[1].output = 'different';
  assert.throws(() => verifyTurn(invented, client, probe), /native_file/);
});
test('refuses requested-only targets, replay, unknown runtime and broken continuity', () => {
  for (const change of [{ execution: undefined }, { replay: true }, { execution: { ...turn().execution, venue: 'local-native' } },
    { execution: { ...turn().execution, runtimeVersion: '' } }]) assert.throws(() => verifyTurn({ ...turn(), ...change }, client, probe));
  assert.throws(() => verifyTurn(turn(), client, probe, turn()), /continuation/);
});
test('refuses non-disposable projects and duplicate harness configuration', () => {
  const config = { disposableProject: true, projectId: 'project', cliVersion: '5.16.1', apiUrl: 'https://fixture.invalid', clients: [client, { ...client, harness: 'claude-code' }] };
  assert.equal(parseConfig(JSON.stringify(config)).clients.length, 2);
  assert.throws(() => parseConfig(JSON.stringify({ ...config, disposableProject: false })));
  assert.throws(() => parseConfig(JSON.stringify({ ...config, clients: [client, client] })));
});
test('CLI infrastructure errors do not become model task failures', () => {
  const report = runCanary({ clients: [client] }, () => { throw Object.assign(new Error('private upstream text'), { exitCode: 3 }); });
  assert.equal(report.results[0].status, 'inconclusive');
  assert.equal(JSON.stringify(report).includes('private upstream text'), false);
});

test('a single tee call cannot prove a separate write and read', () => {
  const value = turn();
  value.toolCalls = value.toolCalls.filter(call => call.toolCallId !== 'w');
  value.toolCalls[0].input = { command: 'echo native-content | tee file.txt' };
  assert.throws(() => verifyTurn(value, client, probe), /native_file_write/);
});
test('a missing runtime receipt is inconclusive rather than a task failure', () => {
  const report = runCanary({ clients: [client] }, () => ({ ...turn(), execution: undefined }));
  assert.equal(report.results[0].status, 'inconclusive');
});
