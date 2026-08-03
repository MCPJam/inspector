import assert from 'node:assert';
import { describe, it } from 'node:test';

import { formatRunOutcome } from '../../../listeners/actions/run-suite-button.js';

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
});
