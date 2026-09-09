import assert from 'node:assert';
import { describe, it } from 'node:test';
import { formatRunOutcome as viaShim } from '../../../listeners/actions/run-suite-button.js';
import { formatRunOutcome, TERMINAL_STATUSES } from '../../../listeners/actions/run-watcher.js';

describe('formatRunOutcome', () => {
  const url = 'https://x/evals/suite/s/runs/r';

  it('formats a pass with counts', () => {
    const text = formatRunOutcome(
      { status: 'completed', result: 'passed', summary: { passed: 3, total: 3 } },
      url,
      'U1',
    );
    assert.ok(text.includes(':large_green_circle:'));
    assert.ok(text.includes('(3/3 passed)'));
    assert.ok(text.includes(url));
  });

  it('formats a failure', () => {
    const text = formatRunOutcome(
      { status: 'completed', result: 'failed', summary: { passed: 1, total: 3 } },
      url,
      'U1',
    );
    assert.ok(text.includes(':red_circle:'));
    assert.ok(text.includes('(1/3 passed)'));
  });

  it('formats a cancellation', () => {
    const text = formatRunOutcome({ status: 'cancelled', result: null }, url, 'U1');
    assert.ok(text.includes('cancelled'));
  });

  it('formats a backend timeout', () => {
    const text = formatRunOutcome({ status: 'timed_out', result: null }, url, 'U1');
    assert.ok(text.includes('timed out'));
    assert.ok(!text.includes('timed_out'), 'raw status should not leak into Slack copy');
  });

  it('formats an inconclusive run as a warning, never as a failure', () => {
    // The bug this branch fixes: `inconclusive` fell through to the red branch,
    // so a run that did not measure the server well enough to judge it was
    // announced in Slack as a defect somebody should go and find.
    const text = formatRunOutcome(
      { status: 'completed', result: 'inconclusive', summary: { passed: 0, total: 3 } },
      url,
      'U1',
    );
    assert.ok(text.startsWith(':warning:'), 'inconclusive is a warning tier, not red');
    assert.ok(text.includes('Run inconclusive (0/3 passed)'));
    assert.ok(text.includes('it did not measure the server well enough to judge it'));
    assert.ok(text.includes('see what it measured'));
    assert.ok(!text.includes('see what broke'), 'must not send a reader hunting for a defect');
    assert.ok(!text.includes(':red_circle:'));
  });

  it('formats a run held for its GATING JUDGE as informational, never red', () => {
    // B10e. A run in `grading` has finished every trial and is waiting for the
    // judge that may still take a green away — it has no verdict. Left to the
    // red branch it read ':red_circle: Run grading … see what broke', which is
    // a defect claim about a run nothing has decided.
    const text = formatRunOutcome(
      { status: 'grading', result: 'pending', summary: { passed: 2, total: 2 } },
      url,
      'U1',
    );
    assert.ok(text.startsWith(':hourglass_flowing_sand:'), 'still in flight, not a verdict');
    assert.ok(text.includes('Run is being graded by its judge'));
    assert.ok(!text.includes(':red_circle:'));
    assert.ok(!text.includes('see what broke'), 'must not blame the server');
    // NO COUNTS: the pass count is exactly the number the judge may overturn.
    assert.ok(!text.includes('2/2'));
  });
});

describe('the first-break line', () => {
  const url = 'https://x/evals/suite/s/runs/r';
  /** A decision summary whose first diagnostic broke at `stage` for `reason`. */
  const summaryWithBreak = (stage, reason) => ({
    diagnostics: {
      items: [
        {
          chain: {
            status: 'verified',
            stages: [{ stage, state: 'failed', reason }],
            firstFailedStage: stage,
          },
        },
      ],
    },
  });

  it('names where the chain broke, on its own line under the verdict', () => {
    const text = formatRunOutcome(
      { status: 'completed', result: 'failed', summary: { passed: 1, total: 3 } },
      url,
      'U1',
      summaryWithBreak('selection', 'missingToolCall'),
    );
    const [verdict, chain] = text.split('\n');
    assert.ok(verdict.startsWith(':red_circle: Run failed (1/3 passed)'));
    assert.equal(chain, 'First break: Selection — an expected tool call was never made');
  });

  it('speaks the vocabulary, never the wire enum', () => {
    const text = formatRunOutcome(
      { status: 'completed', result: 'failed' },
      url,
      'U1',
      summaryWithBreak('userValue', 'judgeFailed'),
    );
    assert.ok(text.includes('First break: User value — the LLM judge scored below the partial floor'));
    for (const wire of ['userValue', 'judgeFailed']) {
      assert.ok(!text.includes(wire), `raw ${wire} leaked into Slack copy`);
    }
  });

  it('rides on an inconclusive run too — the reader who knows least', () => {
    const text = formatRunOutcome(
      { status: 'completed', result: 'inconclusive' },
      url,
      'U1',
      summaryWithBreak('connection', 'egressUnverified'),
    );
    assert.ok(text.startsWith(':warning:'));
    assert.ok(
      text.endsWith(
        '\nFirst break: Connection — the connection failed with no evidence that our own network egress works',
      ),
    );
  });

  it('is FAIL-SOFT: no summary renders exactly the pre-chain line', () => {
    const bare = formatRunOutcome({ status: 'failed', result: null }, url, 'U1');
    assert.ok(!bare.includes('\n'));
    for (const absent of [null, undefined, {}, { diagnostics: { items: [] } }]) {
      assert.equal(formatRunOutcome({ status: 'failed', result: null }, url, 'U1', absent), bare);
    }
  });
});

describe('terminal statuses', () => {
  it('treats every backend terminal status as terminal', () => {
    // Guards the poller against spinning for the full watch window on a
    // status the backend considers finished (server/routes/v1/evals.ts).
    for (const status of ['completed', 'failed', 'cancelled', 'timed_out']) {
      assert.ok(TERMINAL_STATUSES.has(status), `${status} missing from TERMINAL_STATUSES`);
    }
  });
});

describe('the retired Run-it shim', () => {
  it('still re-exports the watcher helpers for buttons on old messages', () => {
    // Slack messages are permanent: the button on a reply posted before the
    // switch is still there and still clickable.
    assert.strictEqual(viaShim, formatRunOutcome);
  });
});
