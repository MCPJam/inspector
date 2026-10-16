import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFlowEvidence, evidenceFailure } from '../hosted-harness-flow-evidence.mjs';

const client = { harness: 'codex', fixtureServerId: 'fixture-server', fixtureToolName: 'fixture', fixtureInput: { value: 'exact' } };
const probe = { file: 'nonce-file.txt', nonce: 'secret-nonce' };
const execution = { engine: 'harness:codex', venue: 'hosted', runtimeVersion: '0.149.1' };
function fixture() {
  const calls = [
    { id: 'write', promptIndex: 0, input: { file: probe.file, content: probe.nonce }, output: 'ok' },
    { id: 'read', promptIndex: 0, input: { file: probe.file }, output: probe.nonce },
    { id: 'mcp', promptIndex: 0, input: client.fixtureInput, output: 'ok' },
    { id: 'again', promptIndex: 1, input: { file: probe.file }, output: probe.nonce },
  ];
  return {
    messages: calls.flatMap(call => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: call.id, input: call.input }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.id, output: call.output }] },
    ]),
    trace: { spans: [
      ...[0, 1].map(promptIndex => ({ category: 'llm', promptIndex, execution })),
      ...calls.map(call => ({ category: 'tool', promptIndex: call.promptIndex, status: 'ok', toolCallId: call.id,
        toolOrigin: call.id === 'mcp' ? 'mcp' : 'native', serverId: client.fixtureServerId,
        toolName: client.fixtureToolName, wireCorroborated: true, evidenceStatus: 'complete' })),
    ] },
  };
}

test('proves two persisted turns from runtime identity and joined tool evidence', () => {
  assert.equal(verifyFlowEvidence(fixture(), client, probe).status, 'passed');
});

test('request identity never fills a missing runtime receipt', () => {
  const trace = fixture();
  trace.execution = execution;
  trace.trace.spans = trace.trace.spans.filter(span => span.category !== 'llm');
  assert.throws(() => verifyFlowEvidence(trace, client, probe), /missing_two_turns/);
  assert.equal(evidenceFailure(new Error('missing_execution_receipt')).status, 'inconclusive');
});

test('rejects wrong venue, uncorroborated MCP, and changed fixture input', () => {
  for (const alter of [
    trace => { trace.trace.spans[0] = { ...trace.trace.spans[0], execution: { ...execution, venue: 'local-native' } }; },
    trace => { trace.trace.spans.find(span => span.toolCallId === 'mcp').wireCorroborated = false; },
    trace => { trace.messages[4].content[0].input = { value: 'almost' }; },
  ]) {
    const trace = fixture(); alter(trace);
    assert.throws(() => verifyFlowEvidence(trace, client, probe));
  }
});

test('requires separate write/read calls and an independent second-turn file read', () => {
  for (const alter of [
    trace => { trace.messages[0].content[0].input = { file: probe.file }; },
    trace => { trace.messages[6].content[0].input = { file: probe.file, echo: probe.nonce }; },
    trace => { trace.messages[7].content[0].output = 'invented'; },
  ]) {
    const trace = fixture(); alter(trace);
    assert.throws(() => verifyFlowEvidence(trace, client, probe), /native_file/);
  }
});

test('truncated observations and transport failures stay inconclusive', () => {
  const trace = fixture(); trace.messagesTruncated = true;
  assert.throws(() => verifyFlowEvidence(trace, client, probe), /truncated_trace/);
  assert.equal(evidenceFailure(new Error('private upstream details')).reason, 'request_did_not_complete');
  assert.equal(evidenceFailure(new Error('native_file_read_unproven')).status, 'task_failed');
});
