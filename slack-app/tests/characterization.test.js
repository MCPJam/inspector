/**
 * CHARACTERIZATION SNAPSHOTS — the contract the surface-core migration must not break.
 *
 * Every string in here is something a person reads in Slack today. The values are
 * written out literally, not computed, so a refactor that "still passes" because
 * both sides changed together is impossible: to make this file green you have to
 * edit an expectation, and editing an expectation is a product decision.
 *
 * Add to this file when you add user-visible copy. Change it only when you MEAN
 * to change what Slack says.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { McpjamApiError } from '../agent/mcpjam-client.js';
import { announcementFor } from '../listeners/actions/proposal-button.js';
import { formatRunOutcome } from '../listeners/actions/run-watcher.js';
import {
  buildCreatedResourceBlocks,
  escapeSlackText,
  toSafeResourceUrl,
} from '../listeners/views/agent-reply-builder.js';
import { buildProposalBlocks } from '../listeners/views/proposal-builder.js';
import { friendlyMessage } from '../render/slack.js';

test('friendlyMessage — every failure code a user can see', () => {
  const message = (code) => friendlyMessage(new McpjamApiError('raw', { code }));

  assert.equal(
    message('RATE_LIMITED'),
    ":hourglass_flowing_sand: I'm at capacity right now — give it a minute and try again.",
  );
  assert.equal(
    message('TIMEOUT'),
    ':hourglass: That took longer than I allow for one reply. Try breaking the request into smaller steps.',
  );
  assert.equal(message('SERVER_UNREACHABLE'), ":satellite: I can't reach MCPJam right now. Try again in a moment.");
  assert.equal(message('UNAUTHORIZED'), ':link: I need you to connect your MCPJam account before I can do that.');
  assert.equal(message('FORBIDDEN'), ":lock: You don't have access to the project this thread is working in.");
  assert.equal(message('NO_PROJECT'), ':warning: Something went wrong talking to MCPJam. Try again in a moment.');
  assert.equal(message(undefined), ':warning: Something went wrong talking to MCPJam. Try again in a moment.');
});

test('formatRunOutcome — the watcher’s terminal messages', () => {
  const url = 'https://app.mcpjam.com/evals/suite/s1/runs/r1?project=p1';
  const user = 'U123';

  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'passed' }, url, user),
    `:large_green_circle: Run passed — started by <@${user}>, <${url}|see the details>.`,
  );
  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'passed', summary: { passed: 3, total: 5 } }, url, user),
    `:large_green_circle: Run passed (3/5 passed) — started by <@${user}>, <${url}|see the details>.`,
  );
  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'failed', summary: { passed: 1, total: 4 } }, url, user),
    `:red_circle: Run failed (1/4 passed) — started by <@${user}>, <${url}|see what broke>.`,
  );
  assert.equal(
    formatRunOutcome({ status: 'failed' }, url, user),
    `:red_circle: Run failed — started by <@${user}>, <${url}|see what broke>.`,
  );
  assert.equal(
    formatRunOutcome({ status: 'cancelled' }, url, user),
    `:heavy_minus_sign: Run cancelled — started by <@${user}>, <${url}|details>.`,
  );
  assert.equal(
    formatRunOutcome({ status: 'timed_out', summary: { passed: 0, total: 2 } }, url, user),
    `:hourglass: Run timed out (0/2 passed) — started by <@${user}>, <${url}|details>.`,
  );
  // A NO-VERDICT IS NOT A FAILURE. This line used to be the red one.
  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'inconclusive', summary: { passed: 0, total: 3 } }, url, user),
    `:warning: Run inconclusive (0/3 passed) — it did not measure the server well enough to judge it — started by <@${user}>, <${url}|see what it measured>.`,
  );
  // An unknown terminal status falls through to the red branch and names itself.
  assert.equal(
    formatRunOutcome({ status: 'exploded' }, url, user),
    `:red_circle: Run exploded — started by <@${user}>, <${url}|see what broke>.`,
  );
});

test('formatRunOutcome — the chain line a non-pass carries beneath its verdict', () => {
  const url = 'https://app.mcpjam.com/evals/suite/s1/runs/r1?project=p1';
  const user = 'U123';
  /** One page of diagnostics, as `GET …/decision-summary` returns it. */
  const summary = {
    diagnostics: {
      items: [
        {
          chain: {
            status: 'verified',
            stages: [
              { stage: 'connection', state: 'passed', reason: 'observed' },
              { stage: 'response', state: 'failed', reason: 'toolError' },
            ],
            firstFailedStage: 'response',
            failureCategory: 'serverData',
          },
        },
      ],
    },
  };

  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'failed', summary: { passed: 1, total: 4 } }, url, user, summary),
    `:red_circle: Run failed (1/4 passed) — started by <@${user}>, <${url}|see what broke>.\n` +
      'First break: Response — the server reported a tool error',
  );

  // A run that reached NO stage names its bucket instead of inventing one.
  assert.equal(
    formatRunOutcome({ status: 'failed' }, url, user, {
      diagnostics: { items: [{ chain: { status: 'verified', stages: [], failureCategory: 'evaluator' } }] },
    }),
    `:red_circle: Run failed — started by <@${user}>, <${url}|see what broke>.\n` +
      'No stage was reached — grouped under evaluator',
  );

  // FAIL-SOFT: the enrichment is absent and the line is what it always was.
  assert.equal(
    formatRunOutcome({ status: 'completed', result: 'failed', summary: { passed: 1, total: 4 } }, url, user, null),
    `:red_circle: Run failed (1/4 passed) — started by <@${user}>, <${url}|see what broke>.`,
  );
});

test('announcementFor — kind wins, then operation, then claim nothing', () => {
  const user = 'U9';
  const url = 'https://app.mcpjam.com/evals/suite/s1/runs/r1';

  // A URL outranks the copy, whatever the kind.
  assert.equal(
    announcementFor({ operation: 'run_eval_suite', kind: 'start', resource: { url } }, user),
    `:white_check_mark: Approved by <@${user}> — <${url}|follow it here>.`,
  );
  assert.equal(
    announcementFor({ operation: 'x', kind: 'start', resource: null, runUrl: url }, user),
    `:white_check_mark: Approved by <@${user}> — <${url}|follow it here>.`,
  );

  // Kind-first, no URL.
  assert.equal(
    announcementFor({ operation: 'x', kind: 'cancel' }, user),
    `:white_check_mark: Cancelled by <@${user}>.`,
  );
  assert.equal(
    announcementFor({ operation: 'x', kind: 'generate' }, user),
    `:white_check_mark: Approved by <@${user}> — the cases are being generated.`,
  );
  assert.equal(
    announcementFor({ operation: 'x', kind: 'schedule' }, user),
    `:white_check_mark: Approved by <@${user}> — the schedule is updated.`,
  );
  assert.equal(
    announcementFor({ operation: 'x', kind: 'external' }, user),
    `:white_check_mark: Approved by <@${user}> — the tool ran.`,
  );
  assert.equal(
    announcementFor({ operation: 'x', kind: 'start' }, user),
    `:white_check_mark: Approved by <@${user}>, and it's away.`,
  );

  // An unrecognised kind means a NEWER server: claim nothing, never consult
  // the older operation-name table.
  assert.equal(
    announcementFor({ operation: 'run_eval_suite', kind: 'teleport' }, user),
    `:white_check_mark: Approved by <@${user}>.`,
  );

  // No kind at all means an OLDER server: fall back to operation names.
  assert.equal(announcementFor({ operation: 'cancel_eval_run' }, user), `:white_check_mark: Cancelled by <@${user}>.`);
  assert.equal(
    announcementFor({ operation: 'generate_eval_cases' }, user),
    `:white_check_mark: Approved by <@${user}> — the cases are being generated.`,
  );
  assert.equal(
    announcementFor({ operation: 'run_eval_suite' }, user),
    `:white_check_mark: Approved by <@${user}>, and it's away.`,
  );
  assert.equal(
    announcementFor({ operation: 'run_eval_case' }, user),
    `:white_check_mark: Approved by <@${user}>, and it's away.`,
  );
  assert.equal(announcementFor({ operation: 'who_knows' }, user), `:white_check_mark: Approved by <@${user}>.`);
});

test('escapeSlackText and toSafeResourceUrl', () => {
  assert.equal(escapeSlackText('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  assert.equal(toSafeResourceUrl('https://app.mcpjam.com/a|b'), 'https://app.mcpjam.com/a%7Cb');
});

test('buildProposalBlocks — the approval surface', () => {
  const blocks = buildProposalBlocks([
    {
      actionId: 'act_1',
      operation: 'run_eval_suite',
      description: 'Run the checkout suite',
      buttonLabel: 'Run it',
      kind: 'start',
      confirmSeverity: 'spend',
    },
  ]);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'expected blocks');
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /Run the checkout suite/);
  assert.match(serialized, /"text":"Run it"/);
  assert.match(serialized, /act_1/);
});

test('buildCreatedResourceBlocks — a created suite still renders', () => {
  const blocks = buildCreatedResourceBlocks([
    { type: 'eval_suite', id: 'suite_1', name: 'Checkout', url: 'https://app.mcpjam.com/evals/suite/suite_1' },
  ]);
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /Checkout/);
  assert.match(serialized, /suite_1/);
});
