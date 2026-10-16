import { isDeepStrictEqual } from 'node:util';

const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };
const text = value => JSON.stringify(value) ?? '';

/** Join the actual tool-call/result messages, never the requested tool list. */
function callsFrom(messages) {
  const calls = new Map();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.set(part.toolCallId, {
        id: part.toolCallId, input: part.input ?? part.args,
      });
    }
  }
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const call = calls.get(part.toolCallId);
      if (call && part.type === 'tool-result') {
        call.output = part.output ?? part.result;
        call.failed = part.isError === true;
      }
    }
  }
  return calls;
}

/** Evidence comes from persisted step/LLM spans after the engine ran. */
export function verifyFlowEvidence(envelope, client, probe) {
  const spans = envelope?.trace?.spans ?? envelope?.spans;
  requireThat(Array.isArray(spans) && Array.isArray(envelope.messages), 'missing_trace');
  requireThat(envelope.traceComplete !== false && !envelope.messagesTruncated && !envelope.spansTruncated &&
    !envelope.messages.some(message => message.truncated), 'truncated_trace');
  const executionSpans = spans.filter(span => ['step', 'llm'].includes(span.category));
  const indices = [...new Set(executionSpans.map(span => span.promptIndex))]
    .filter(Number.isInteger).sort((a, b) => a - b);
  requireThat(indices.length === 2, 'missing_two_turns');
  const calls = callsFrom(envelope.messages);
  const turns = indices.map((promptIndex, turn) => {
    const records = executionSpans.filter(span => span.promptIndex === promptIndex);
    requireThat(records.length > 0 && records.every(span => span.execution), 'missing_execution_receipt');
    for (const { execution } of records) {
      requireThat(execution.engine === `harness:${client.harness}` && execution.venue === 'hosted', 'wrong_execution_target');
      requireThat(typeof execution.runtimeVersion === 'string' && execution.runtimeVersion.trim(), 'missing_runtime_version');
    }
    const tools = spans.filter(span => span.promptIndex === promptIndex && span.category === 'tool' && span.status === 'ok');
    const observed = span => {
      const call = calls.get(span.toolCallId);
      return call && !call.failed && call.output !== undefined ? call : undefined;
    };
    const native = tools.filter(span => span.toolOrigin === 'native').map(observed).filter(Boolean);
    const read = native.find(call => text(call.input).includes(probe.file) &&
      !text(call.input).includes(probe.nonce) && text(call.output).includes(probe.nonce));
    requireThat(read, 'native_file_read_unproven');
    if (turn === 0) {
      requireThat(native.some(call => call.id !== read.id && text(call.input).includes(probe.file) &&
        text(call.input).includes(probe.nonce)), 'native_file_write_unproven');
      requireThat(tools.some(span => span.toolOrigin === 'mcp' && span.serverId === client.fixtureServerId &&
        span.toolName === client.fixtureToolName && span.wireCorroborated === true && span.evidenceStatus === 'complete' &&
        isDeepStrictEqual(observed(span)?.input, client.fixtureInput)), 'exact_mcp_call_unproven');
    }
    return { promptIndex, ...records[0].execution };
  });
  return { status: 'passed', turns };
}

export function evidenceFailure(error) {
  const reason = error instanceof Error ? error.message : '';
  if (/^(missing_|truncated_)/.test(reason)) return { status: 'inconclusive', reason };
  if (['wrong_execution_target', 'native_file_read_unproven', 'native_file_write_unproven', 'exact_mcp_call_unproven'].includes(reason)) {
    return { status: 'task_failed', reason };
  }
  return { status: 'inconclusive', reason: 'request_did_not_complete' };
}
