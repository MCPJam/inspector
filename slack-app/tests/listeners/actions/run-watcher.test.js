import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { announceAndWatchRun, isFailedOutcome, watchRunUntilDone } from '../../../listeners/actions/run-watcher.js';

const POLL_INTERVAL_MS = 10_000;

describe('isFailedOutcome', () => {
  it('matches exactly the red-circle branch of formatRunOutcome', () => {
    // Evidence and outcome copy must never disagree: this predicate is what
    // keeps "see what broke" and the screenshots pointing at the same runs.
    assert.strictEqual(isFailedOutcome({ status: 'failed', result: null }), true);
    assert.strictEqual(isFailedOutcome({ status: 'completed', result: 'failed' }), true);
    assert.strictEqual(isFailedOutcome({ status: 'completed', result: 'passed' }), false);
    assert.strictEqual(isFailedOutcome({ status: 'cancelled', result: null }), false);
    assert.strictEqual(isFailedOutcome({ status: 'timed_out', result: null }), false);
  });
});

describe('watchRunUntilDone', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
  });

  const ctx = { teamId: 'T1', slackUserId: 'U1', mode: 'user', projectId: 'p1' };
  const logger = /** @type {any} */ ({ warn: () => {}, error: () => {}, info: () => {} });

  /** @param {Record<string, any>} run */
  function stubRun(run) {
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(run), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }

  /**
   * Drive the watcher through its first poll: it sleeps BEFORE polling, so
   * the mocked clock must advance once for anything to happen at all.
   * @param {Promise<void>} watcher
   */
  async function firstPoll(watcher) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(POLL_INTERVAL_MS);
    await watcher;
  }

  it('edits the outcome FIRST, then runs the completion hook', async () => {
    // The hook is strictly additive. If it ran first, a slow screenshot pass
    // would leave the thread saying "running…" long after the run ended.
    //
    // The same rule now covers the chain enrichment, which is why this run
    // records TWO updates: the verdict goes out immediately with no summary,
    // and the decision-summary read — which can take up to its own 30s
    // timeout — happens after, producing a second edit. The invariant this
    // test names is unchanged and stronger: nothing optional precedes the
    // verdict reaching the thread. Here the enrichment fetch is the same
    // `globalThis.fetch` stub, so it resolves to the run body, which carries
    // no diagnostics and still yields a second edit only because the stub
    // answers; a real absent summary produces one edit.
    stubRun({ status: 'completed', result: 'failed' });
    /** @type {string[]} */
    const order = [];
    const client = /** @type {any} */ ({
      chat: {
        update: async () => {
          order.push('update');
          return { ok: true };
        },
      },
    });
    await firstPoll(
      watchRunUntilDone(client, {
        runId: 'run_1',
        url: 'https://app.test/run_1',
        ctx,
        channelId: 'C1',
        statusTs: '1.0',
        userId: 'U1',
        logger,
        onTerminal: async (run) => {
          order.push(`hook:${run.status}/${run.result}`);
        },
      }),
    );
    // The VERDICT edit is first and the hook is last; the enrichment edit
    // sits between them and can never delay either.
    assert.strictEqual(order[0], 'update');
    assert.strictEqual(order.at(-1), 'hook:completed/failed');
    assert.deepStrictEqual(
      order.filter((entry) => entry !== 'update'),
      ['hook:completed/failed'],
    );
  });

  it('a rejecting completion hook is logged, never thrown', async () => {
    // An unhandled rejection here would take down a watcher whose outcome
    // message is already correct — trading the important thing for the extra.
    stubRun({ status: 'completed', result: 'passed' });
    const warnings = [];
    const client = /** @type {any} */ ({
      chat: { update: async () => ({ ok: true }) },
    });
    await firstPoll(
      watchRunUntilDone(client, {
        runId: 'run_1',
        url: 'https://app.test/run_1',
        ctx,
        channelId: 'C1',
        statusTs: '1.0',
        userId: 'U1',
        logger: /** @type {any} */ ({
          warn: (message) => warnings.push(String(message)),
          error: () => {},
          info: () => {},
        }),
        onTerminal: async () => {
          throw new Error('screenshot pass exploded');
        },
      }),
    );
    assert.strictEqual(warnings.filter((w) => w.includes('screenshot pass exploded')).length, 1);
  });
});

describe('announceAndWatchRun', () => {
  it('does not start a watcher for a message Slack never posted', async () => {
    // A watcher with no `ts` has nothing to edit; polling would be pure load.
    let fetched = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ (
      async () => {
        fetched += 1;
        throw new Error('should never poll');
      }
    );
    try {
      const client = /** @type {any} */ ({
        chat: { postMessage: async () => ({ ok: false }) },
      });
      await announceAndWatchRun(client, {
        runId: 'run_1',
        url: 'https://app.test/run_1',
        ctx: { teamId: 'T1', slackUserId: 'U1', mode: 'user', projectId: 'p1' },
        channelId: 'C1',
        threadTs: '1.0',
        userId: 'U1',
        logger: /** @type {any} */ ({ warn: () => {}, error: () => {}, info: () => {} }),
      });
      assert.strictEqual(fetched, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
