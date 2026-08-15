import assert from 'node:assert';
import { describe, it } from 'node:test';
import { journeyRunOutcome } from '@mcpjam/surface-core';
import { formatJourneyRunOutcome } from '../../../listeners/actions/journey-run-watcher.js';

/**
 * The Slack line is derived from the core's OUTCOME, never from `status` — the
 * cases below are exactly the ones a status-only formatter gets wrong, and
 * each pins the copy a person acts on.
 */
describe('formatJourneyRunOutcome', () => {
  const url = 'https://x/swarms/run_1?project=p1';

  /** @param {Record<string, any>} run */
  const format = (run) => formatJourneyRunOutcome(run, journeyRunOutcome(run), url, 'U1');

  it('formats a clean pass with session counts', () => {
    const text = format({ status: 'completed', summary: { total: 10, succeeded: 10, failed: 0 } });
    assert.ok(text.includes(':large_green_circle:'));
    assert.ok(text.includes('(10/10 sessions reached their goal)'));
    assert.ok(text.includes('<@U1>'));
    assert.ok(text.includes(url));
  });

  it('calls a completed run with failures MIXED, not passed', () => {
    // The verdict lives in the summary. `status: completed` alone would put a
    // green circle on a fan-out where most sessions missed their goal.
    const text = format({ status: 'completed', summary: { total: 10, succeeded: 4, failed: 6 } });
    assert.ok(text.includes(':large_yellow_circle:'));
    assert.ok(text.includes('mixed'));
    assert.ok(text.includes('(4/10'));
  });

  it('reports a canceled run as STOPPED, not failed', () => {
    // A stopped run arrives as `status: failed, canceled: true`. Telling the
    // person who pressed Stop that their run failed sends them bug-hunting.
    const text = format({ status: 'failed', canceled: true, summary: { total: 4, succeeded: 2, failed: 2 } });
    assert.ok(text.includes('stopped by request'));
    assert.ok(!text.includes(':red_circle:'));
  });

  it('reports a stale run as the runner going silent', () => {
    const text = format({ status: 'running', stale: true, summary: { total: 4, succeeded: 1, failed: 0 } });
    assert.ok(text.includes('went silent'));
    assert.ok(text.includes('incomplete'));
  });

  it('says what rate_limited means instead of naming the enum', () => {
    const text = format({ status: 'rate_limited', summary: { total: 8, succeeded: 3, failed: 1, rateLimited: 4 } });
    assert.ok(text.includes('model capacity ran out'));
    assert.ok(!text.includes('rate_limited'));
  });

  it('omits the counts clause when the summary is empty', () => {
    // A run that died before producing sessions has nothing to count;
    // "(0/0 sessions…)" reads as a bug, not a report.
    const text = format({ status: 'failed' });
    assert.ok(!text.includes('(0/0'));
    assert.ok(text.includes(':red_circle:'));
  });
});
