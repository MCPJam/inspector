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

  /** @param {unknown} body */
  function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * A run poll and a decision-summary read answer DIFFERENTLY, which the
   * single-body stub above cannot express. Without the split, the summary
   * read resolves to the run body, which carries no chain — so a test meaning
   * to exercise the enrichment would silently exercise its absence.
   *
   * @param {Record<string, any>} run
   * @param {Record<string, any>} summary
   */
  function stubRoutes(run, summary) {
    globalThis.fetch = mock.fn(async (/** @type {any} */ url) =>
      String(url).includes('/decision-summary') ? jsonResponse(summary) : jsonResponse(run),
    );
  }

  /**
   * A minimal summary that renders a first-break sentence: only a `verified`
   * chain carries stages, so `unverified` and `absent` produce no line at all.
   */
  const DECISION_SUMMARY = {
    verdict: 'failed',
    verdictSource: 'gate',
    diagnostics: {
      complete: true,
      items: [
        {
          chain: {
            status: 'verified',
            firstFailedStage: 'selection',
            stages: [{ stage: 'selection', state: 'failed', reason: 'toolNotCalled' }],
          },
        },
      ],
    },
  };

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

  it('edits the VERDICT first, unenriched, then enriches in a second edit', async () => {
    // The hook is strictly additive. If it ran first, a slow screenshot pass
    // would leave the thread saying "running…" long after the run ended.
    //
    // The same rule covers the chain enrichment, so a failed run records TWO
    // updates: the verdict goes out immediately carrying no summary, and the
    // decision-summary read — which can take up to its own 30s timeout —
    // produces a second edit once it returns. This test pins BOTH halves,
    // because assertions on the first and last entry alone would pass if the
    // enrichment vanished entirely, or if the verdict edit already carried
    // the chain sentence.
    stubRoutes({ status: 'completed', result: 'failed' }, DECISION_SUMMARY);
    /** @type {string[]} */
    const order = [];
    /** @type {string[]} */
    const texts = [];
    const client = /** @type {any} */ ({
      chat: {
        update: async (/** @type {any} */ args) => {
          order.push('update');
          texts.push(String(args?.text ?? ''));
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
    // TWO distinct edits, not one — the count is the assertion the weaker
    // first/last checks were missing.
    assert.strictEqual(
      order.filter((entry) => entry === 'update').length,
      2,
      `expected a verdict edit and an enrichment edit, got ${JSON.stringify(order)}`,
    );
    assert.strictEqual(order[0], 'update');
    // The verdict edit is UNENRICHED and the second one carries the chain,
    // which is the direction of the change: the sentence must arrive after
    // the verdict, never with it.
    assert.ok(!texts[0].includes('First break'), `verdict edit leaked the chain: ${texts[0]}`);
    assert.ok(texts[1].includes('First break'), `enrichment edit lost the chain: ${texts[1]}`);
    assert.ok(order.includes('hook:completed/failed'));
  });

  it('does not gate the completion hook behind the decision-summary read', async () => {
    // `onTerminal` is where a surface uploads failure evidence, and a FAILED
    // run is exactly the case that also wants a chain line. Sequencing the
    // two put the summary read in front of every screenshot upload — so this
    // asserts the hook has already run while that read is still outstanding.
    let summaryReadStarted = false;
    let releaseSummary = () => {};
    globalThis.fetch = mock.fn(async (/** @type {any} */ url) => {
      if (String(url).includes('/decision-summary')) {
        summaryReadStarted = true;
        // Hangs until released, standing in for a slow or degraded route.
        await new Promise((release) => {
          releaseSummary = () => release(undefined);
        });
        return jsonResponse(DECISION_SUMMARY);
      }
      return jsonResponse({ status: 'completed', result: 'failed' });
    });
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
    const watcher = watchRunUntilDone(client, {
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
    });
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(POLL_INTERVAL_MS);
    // Drain a BOUNDED number of turns rather than awaiting the read directly:
    // if the enrichment regressed to never reading at all, awaiting it would
    // hang this test until the runner's own timeout and cancel its siblings,
    // which reports the regression as a stall instead of naming it.
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(summaryReadStarted, 'the enrichment never read the decision summary');
    // THE POINT: the hook is done while the summary read is still hanging.
    assert.ok(order.includes('hook:completed/failed'), `the hook waited on the summary read: ${JSON.stringify(order)}`);
    assert.strictEqual(order.filter((entry) => entry === 'update').length, 1);
    releaseSummary();
    await watcher;
    assert.strictEqual(order.filter((entry) => entry === 'update').length, 2);
  });

  // Every summary shape that arrives fine and still has nothing to add. The
  // chain lives at `diagnostics.items[0].chain` — a `chain` key at the top of
  // the summary is read by nothing, so a fixture that put one there would test
  // the EMPTY-ITEMS path under a comment claiming to test `unverified`.
  // The shapes are the ones the wire actually sends: an `unverified` chain
  // carries `{ status, analyzerVersion }` and nothing else. That the GUARD
  // holds even when rows ARE present is pinned where `formatFirstBreak` lives,
  // in surface-core's copy.test.js — the subject here is the watcher's edit
  // count, not the renderer's refusal.
  const NOTHING_TO_ADD = [
    [
      'an unverified chain, whose rows were withheld',
      { complete: true, items: [{ chain: { status: 'unverified', analyzerVersion: 4 } }] },
    ],
    ['an absent chain, which never stored rows', { complete: true, items: [{ chain: { status: 'absent' } }] }],
    ['no diagnostics at all', { complete: true, items: [] }],
  ];

  for (const [shape, diagnostics] of NOTHING_TO_ADD) {
    it(`spends no second edit on ${shape}`, async () => {
      // All three re-render byte-identical to the verdict already on screen,
      // so editing again would spend a write against Slack's rate limit to
      // change nothing.
      stubRoutes({ status: 'completed', result: 'failed' }, { ...DECISION_SUMMARY, diagnostics });
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
        }),
      );
      assert.strictEqual(
        order.filter((entry) => entry === 'update').length,
        1,
        `expected only the verdict edit, got ${JSON.stringify(order)}`,
      );
    });
  }

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
