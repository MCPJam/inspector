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
