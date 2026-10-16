import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifyFlowEvidence, evidenceFailure } from './hosted-harness-flow-evidence.mjs';

export function invokeCli(config, args, { timeoutMs = 60_000 } = {}) {
  const env = { ...process.env };
  for (const key of ['WORKOS_API_KEY', 'STAGING_WORKOS_API_KEY', 'ASK_MCPJAM_CANARY_PASSWORD', 'HARNESS_PRODUCT_STUDY_TOKENS']) delete env[key];
  const result = spawnSync('npx', ['--yes', `--package=@mcpjam/cli@${config.cliVersion}`, 'mcpjam', ...args,
    '--api-url', config.apiUrl, '--project', config.projectId, '--format', 'json', '--timeout', String(timeoutMs - 15_000)],
  { cwd: tmpdir(), env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw Object.assign(new Error('cli_did_not_complete'), { exitCode: result.status ?? 4 });
  return JSON.parse(result.stdout);
}

export function probePrompts(client, probe) {
  return [
    `Use native file tools to write ${probe.file} with exactly ${probe.nonce}, then use a separate native call to read it back. Call MCP tool ${client.fixtureToolName} with exactly ${JSON.stringify(client.fixtureInput)}.`,
    `Use a native file tool to read ${probe.file} again and return its exact contents. Do not rewrite it or infer it from history.`,
  ];
}

export function evalFile(client, probe) {
  return {
    schemaVersion: '2', mode: 'agentWorkflow', reportingMode: 'standard',
    suite: { id: `canary_${probe.id}`, name: `Harness canary ${probe.id}` },
    target: { environment: client.environmentId },
    defaults: { model: client.modelId, provider: client.harness === 'codex' ? 'openai' : 'anthropic',
      iterations: 1, passThreshold: 1, validity: {}, temperature: 0, judge: { enabled: false } },
    cases: [{ id: 'native_fixture', title: 'Native and exact MCP continuation',
      steps: probePrompts(client, probe).map((prompt, index) => ({ id: `turn_${index}`, kind: 'prompt', prompt })) }],
  };
}

async function waitForRun(kind, runId, invoke, pause) {
  const deadline = Date.now() + 180_000;
  for (let attempt = 0; attempt < 36 && Date.now() < deadline; attempt++) {
    const { run } = await invoke(['cloud', kind, 'status', '--run', runId]);
    if (run && ['completed', 'partial', 'failed', 'cancelled', 'canceled', 'timed_out', 'rate_limited'].includes(run.status)) return run;
    await pause(5_000);
  }
  throw new Error('run_deadline');
}

export async function readSession(sessionId, invoke) {
  const detail = await invoke(['cloud', 'sessions', 'show', '--session', sessionId, '--limit', '200']);
  const trace = await invoke(['cloud', 'sessions', 'trace', '--session', sessionId, '--limit', '3']);
  if (detail.nextCursor || detail.transcriptUnavailable || trace.turns?.some(turn => turn.spansUnavailable || turn.spansTruncated)) {
    throw new Error('truncated_trace');
  }
  return { messages: detail.messages, spans: (trace.turns ?? []).flatMap(turn => turn.spans ?? []) };
}

async function runEval(client, probe, invoke, pause) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-eval-canary-'));
  let runId, suiteId, terminal = false;
  try {
    const file = join(directory, 'suite.json');
    writeFileSync(file, JSON.stringify(evalFile(client, probe)));
    const launch = await invoke(['cloud', 'eval', 'run', '--file', file, '--iterations', '1', '--idempotency-key', probe.id]);
    suiteId = launch.suite?.id;
    if (launch.targets?.length !== 1) {
      for (const target of launch.targets ?? []) {
        if (target.runId) await invoke(['cloud', 'eval', 'cancel', '--run', target.runId]);
      }
      throw new Error('unexpected_target_count');
    }
    runId = launch.targets[0].runId;
    if (!runId) throw new Error('missing_run');
    await waitForRun('eval', runId, invoke, pause); terminal = true;
    const iterations = await invoke(['cloud', 'eval', 'iterations', '--run', runId, '--limit', '2']);
    if (iterations.items?.length !== 1 || iterations.nextCursor) throw new Error('unexpected_iteration_count');
    const { trace } = await invoke(['cloud', 'eval', 'trace', '--run', runId, '--iteration', iterations.items[0].id]);
    return { ...verifyFlowEvidence(trace, client, probe), runId };
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (runId && !terminal) await invoke(['cloud', 'eval', 'cancel', '--run', runId]);
    // Delete only this newly created suite after its run stopped; keep an unfinished run inspectable.
    if (suiteId && terminal) await invoke(['cloud', 'eval', 'delete', '--suite', suiteId]);
  }
}

async function runSwarm(client, probe, invoke, pause) {
  let goalId, runId, terminal = false;
  try {
    const prompts = probePrompts(client, probe);
    const created = await invoke(['cloud', 'goals', 'create', '--name', `Harness canary ${probe.id}`,
      '--persona', client.personaId, '--environment', client.environmentId, '--iterations', '1', '--max-turns', '2',
      '--goal', `In exactly two turns: first ask the client to ${prompts[0]} Next ask: ${prompts[1]}`, '--idempotency-key', probe.id]);
    goalId = created.goal?.id;
    if (!goalId) throw new Error('missing_goal');
    const launched = await invoke(['cloud', 'goals', 'run', '--goal-id', goalId, '--idempotency-key', probe.id]);
    runId = launched.run?.id;
    if (!runId) throw new Error('missing_run');
    const run = await waitForRun('goals', runId, invoke, pause); terminal = true;
    if (run.targets?.length !== 1 || run.summary?.total !== 1) throw new Error('unexpected_target_count');
    const sessions = await invoke(['cloud', 'goals', 'sessions', '--run', runId, '--limit', '2']);
    if (sessions.items?.length !== 1 || sessions.nextCursor) throw new Error('unexpected_session_count');
    return { ...verifyFlowEvidence(await readSession(sessions.items[0].chatSessionId, invoke), client, probe), runId };
  } finally {
    if (runId && !terminal) await invoke(['cloud', 'goals', 'cancel', '--run', runId]);
    if (goalId) await invoke(['cloud', 'goals', 'archive', '--goal-id', goalId]);
  }
}

export async function runAsyncCanaries(config, invoke = args => invokeCli(config, args), pause = ms => new Promise(resolve => setTimeout(resolve, ms))) {
  const results = [];
  for (const client of config.clients) {
    for (const surface of ['eval', 'swarm']) {
      if (!client.environmentId || (surface === 'swarm' && !client.personaId)) {
        results.push({ harness: client.harness, surface, status: 'not_run', reason: 'configuration_missing' });
        continue;
      }
      const id = randomUUID();
      const probe = { id, file: `mcpjam-canary-${id}.txt`, nonce: randomUUID() };
      try {
        const result = await (surface === 'eval' ? runEval : runSwarm)(client, probe, invoke, pause);
        results.push({ harness: client.harness, surface, ...result });
      } catch (error) {
        results.push({ harness: client.harness, surface, ...evidenceFailure(error) });
      }
    }
  }
  return { scope: 'eval-and-swarm', qualification: false, results };
}
