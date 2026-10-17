import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evalFile, probePrompts, runAsyncCanaries } from '../hosted-harness-async-canary.mjs';

const client = { harness: 'codex', modelId: 'openai/gpt-5-nano', environmentId: 'env', fixtureToolName: 'fixture', fixtureInput: { exact: true } };
const probe = { id: 'unique', file: 'unique.txt', nonce: 'nonce' };

test('eval file bounds the target, iteration, judging and two authored prompts', () => {
  const file = evalFile(client, probe);
  assert.deepEqual(file.target, { environment: 'env' });
  assert.equal(file.defaults.iterations, 1);
  assert.equal(file.defaults.passThreshold, 1);
  assert.deepEqual(file.defaults.validity, {});
  assert.deepEqual(file.defaults.judge, { enabled: false });
  assert.equal(file.cases.length, 1);
  assert.equal(file.cases[0].steps.length, 2);
  assert.equal(probePrompts(client, probe)[1].includes(probe.nonce), false);
});

test('eval uses real launch/status/trace commands and deletes only its created suite', async () => {
  const commands = [];
  const report = await runAsyncCanaries({ clients: [client] }, async args => {
    commands.push(args);
    if (args[2] === 'run') {
      const file = JSON.parse(readFileSync(args[4], 'utf8'));
      assert.equal(file.cases[0].steps.length, 2);
      return { suite: { id: 'created-suite' }, targets: [{ runId: 'run' }] };
    }
    if (args[2] === 'status') return { run: { status: 'completed' } };
    if (args[2] === 'iterations') return { items: [{ id: 'iteration' }] };
    if (args[2] === 'trace') return { trace: { messages: [], trace: { spans: [] } } };
    return {};
  }, async () => {});
  assert.equal(report.results[0].status, 'inconclusive');
  assert.equal(report.results[0].reason, 'missing_two_turns');
  assert.deepEqual(commands.at(-1), ['cloud', 'eval', 'delete', '--suite', 'created-suite']);
  assert.equal(report.results[1].status, 'not_run');
});

test('an unfinished eval is bounded and receives cancellation', async () => {
  const commands = [];
  const report = await runAsyncCanaries({ clients: [client] }, async args => {
    commands.push(args);
    if (args[2] === 'run') return { suite: { id: 'suite' }, targets: [{ runId: 'run' }] };
    return { run: { status: 'running' } };
  }, async () => {});
  assert.equal(commands.filter(args => args[2] === 'status').length, 36);
  assert.deepEqual(commands.at(-1), ['cloud', 'eval', 'cancel', '--run', 'run']);
  assert.equal(report.results[0].status, 'inconclusive');
});

test('swarm uses one environment, one iteration and two turns, then archives its own goal', async () => {
  const commands = [];
  const report = await runAsyncCanaries({ clients: [{ ...client, personaId: 'persona' }] }, async args => {
    commands.push(args);
    if (args[1] === 'eval' && args[2] === 'run') throw new Error('not configured in fixture');
    if (args[2] === 'create') {
      assert.equal(args[args.indexOf('--iterations') + 1], '1');
      assert.equal(args[args.indexOf('--max-turns') + 1], '2');
      return { goal: { id: 'created-goal' } };
    }
    if (args[2] === 'run') return { run: { id: 'run' } };
    if (args[2] === 'status') return { run: { status: 'completed', targets: [{}], summary: { total: 1 } } };
    if (args[2] === 'sessions') return { items: [{ chatSessionId: 'session' }] };
    if (args[2] === 'show') return { messages: [] };
    if (args[2] === 'trace') return { turns: [] };
    return {};
  }, async () => {});
  assert.equal(report.results[1].status, 'inconclusive');
  assert.deepEqual(commands.at(-1), ['cloud', 'goals', 'archive', '--goal-id', 'created-goal']);
});
