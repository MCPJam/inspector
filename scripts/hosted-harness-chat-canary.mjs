import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const evidenceReasons = new Set(['native_file_write_unproven', 'missing_turn', 'fresh_saved_turn_required', 'wrong_execution_target', 'missing_execution_identity', 'missing_public_identity', 'continuation_identity_mismatch', 'runtime_continuation_mismatch', 'native_file_read_unproven', 'exact_mcp_call_unproven']);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const requireThat = (condition, reason) => { if (!condition) throw new Error(reason); };

export function parseConfig(raw) {
  const config = JSON.parse(raw);
  requireThat(config.disposableProject === true && nonempty(config.projectId), 'disposable_project_required');
  requireThat(/^\d+\.\d+\.\d+([-.][a-zA-Z0-9.-]+)?$/.test(config.cliVersion), 'exact_cli_version_required');
  requireThat(new URL(config.apiUrl).protocol === 'https:', 'https_api_required');
  requireThat(Array.isArray(config.clients) && config.clients.length === 2, 'two_clients_required');
  requireThat(new Set(config.clients.map(client => client.harness)).size === 2, 'distinct_clients_required');
  for (const client of config.clients) {
    requireThat(['claude-code', 'codex'].includes(client.harness), 'unsupported_harness');
    requireThat([client.clientId, client.modelId, client.fixtureServerId, client.fixtureToolName].every(nonempty), 'client_fixture_required');
    requireThat(client.fixtureInput && typeof client.fixtureInput === 'object' && !Array.isArray(client.fixtureInput), 'fixture_input_required');
  }
  return config;
}

export function verifyTurn(turn, client, probe, previous) {
  requireThat(turn && typeof turn === 'object', 'missing_turn');
  requireThat(turn.replay !== true && turn.persisted?.outcome === 'saved', 'fresh_saved_turn_required');
  const receipt = turn.execution;
  requireThat(receipt, 'missing_execution_identity');
  requireThat(receipt?.engine === `harness:${client.harness}` && receipt.venue === 'hosted', 'wrong_execution_target');
  requireThat([receipt.runtimeVersion, receipt.sessionId, receipt.turnId].every(nonempty), 'missing_execution_identity');
  requireThat(nonempty(turn.sessionId) && nonempty(turn.turnId), 'missing_public_identity');
  if (previous) {
    requireThat(turn.sessionId === previous.sessionId && turn.turnId !== previous.turnId, 'continuation_identity_mismatch');
    requireThat(receipt.sessionId === previous.execution.sessionId && receipt.turnId !== previous.execution.turnId, 'runtime_continuation_mismatch');
  }
  const spans = turn.trace?.spans ?? [];
  const calls = turn.toolCalls ?? [];
  const native = spans.filter(span => span.category === 'tool' && span.toolOrigin === 'native' && span.status === 'ok');
  requireThat(native.some(span => calls.some(call => call.toolCallId === span.toolCallId && call.status === 'ok' &&
    JSON.stringify(call.input).includes(probe.file) && JSON.stringify(call.output)?.includes(probe.nonce) &&
    (!previous || !JSON.stringify(call.input).includes(probe.nonce)))), 'native_file_read_unproven');
  if (!previous) {
    const readIndex = calls.findIndex(call => native.some(span => span.toolCallId === call.toolCallId) &&
      call.status === 'ok' && JSON.stringify(call.input).includes(probe.file) &&
      !JSON.stringify(call.input).includes(probe.nonce) && JSON.stringify(call.output)?.includes(probe.nonce));
    requireThat(readIndex > 0 && calls.slice(0, readIndex).some(call =>
      native.some(span => span.toolCallId === call.toolCallId) && call.status === 'ok' &&
      JSON.stringify(call.input).includes(probe.file) && JSON.stringify(call.input).includes(probe.nonce)), 'native_file_write_unproven');
    requireThat(spans.some(span => span.toolOrigin === 'mcp' && span.serverId === client.fixtureServerId &&
      span.toolName === client.fixtureToolName && span.wireCorroborated === true && span.evidenceStatus === 'complete' &&
      calls.some(call => call.toolCallId === span.toolCallId && call.status === 'ok' &&
        call.truncated !== true && isDeepStrictEqual(call.input, client.fixtureInput))), 'exact_mcp_call_unproven');
  }
  return { engine: receipt.engine, venue: receipt.venue, runtimeVersion: receipt.runtimeVersion,
    sessionId: turn.sessionId, turnId: turn.turnId, runtimeSessionId: receipt.sessionId };
}

function send(config, client, message, key, sessionId) {
  const args = ['--yes', `--package=@mcpjam/cli@${config.cliVersion}`, 'mcpjam', 'cloud', 'sessions', 'send',
    '--api-url', config.apiUrl, '--project', config.projectId, '--client', client.clientId,
    '--message', message, '--idempotency-key', key, '--format', 'json'];
  if (sessionId) args.push('--session', sessionId);
  else args.push('--model', client.modelId, '--tool-mode', 'auto');
  const result = spawnSync('npx', args, { encoding: 'utf8', timeout: 360_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error('cli_did_not_complete'), { exitCode: result.status ?? 4 });
  }
  return JSON.parse(result.stdout);
}

export function runCanary(config, invoke = send) {
  const results = [];
  for (const client of config.clients) {
    const run = randomUUID();
    const probe = { file: `mcpjam-canary-${run}.txt`, nonce: randomUUID() };
    const turns = [];
    try {
      const first = invoke(config, client,
        `In your current workspace, use native file tools to write ${probe.file} with exactly ${probe.nonce} and read it back. Then call the MCP tool ${client.fixtureToolName} with exactly ${JSON.stringify(client.fixtureInput)}. Do not substitute tools.`,
        `${run}-first`);
      turns.push(verifyTurn(first, client, probe));
      const second = invoke(config, client,
        `Use a native file tool to read ${probe.file} again and return its exact contents. Do not rewrite it or infer its contents from conversation history.`,
        `${run}-second`, first.sessionId);
      turns.push(verifyTurn(second, client, probe, first));
      results.push({ harness: client.harness, status: 'passed', turns });
    } catch (error) {
      const code = error.exitCode;
      results.push({ harness: client.harness, status: code === undefined && evidenceReasons.has(error.message) && !error.message.startsWith('missing_') ? 'task_failed' : 'inconclusive',
        reason: evidenceReasons.has(error.message) ? error.message : 'cli_did_not_complete', exitCode: code, turns });
    }
  }
  return { scope: 'cli-chat-only', qualification: false, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    const raw = process.env.HARNESS_CHAT_CANARY_CONFIG;
    requireThat(raw && nonempty(process.env.MCPJAM_API_KEY), 'configuration_missing');
    report = runCanary(parseConfig(raw));
  } catch (error) {
    report = { scope: 'cli-chat-only', qualification: false, status: 'not_run', reason: error.message === 'configuration_missing' ? error.message : 'configuration_invalid' };
  }
  writeFileSync(process.env.HARNESS_CHAT_CANARY_REPORT ?? 'harness-chat-canary.json', JSON.stringify(report, null, 2));
  process.exitCode = report.results?.every(result => result.status === 'passed') ? 0 : 1;
}
