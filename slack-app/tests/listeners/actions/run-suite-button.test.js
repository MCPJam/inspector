import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleRunSuiteButton, runDedupe } from '../../../listeners/actions/run-suite-button.js';

describe('handleRunSuiteButton', () => {
  /** @type {any} */
  let args;
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    runDedupe.clear();
    process.env.MCPJAM_API_KEY = 'sk_test';
    process.env.MCPJAM_PROJECT_ID = 'p1';
    process.env.MCPJAM_BASE_URL = 'https://example.test';
    realFetch = globalThis.fetch;
    args = {
      ack: mock.fn(async () => {}),
      // The button sits on the bot's reply (ts 42.0) inside thread 40.0.
      body: {
        channel: { id: 'C1' },
        message: { ts: '42.0', thread_ts: '40.0' },
        team: { id: 'T1' },
        user: { id: 'U1' },
      },
      action: { value: 'ts_1' },
      context: { userId: 'U1', mcpjamTenancy: { isLegacyWorkspace: true } },
      logger: { error: mock.fn(), warn: mock.fn() },
      client: {
        chat: {
          postMessage: mock.fn(async () => ({ ok: true, ts: '43.0' })),
          postEphemeral: mock.fn(async () => ({ ok: true })),
        },
      },
    };
  });

  function stubApi(status, body) {
    globalThis.fetch = mock.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
  }

  function restore() {
    globalThis.fetch = realFetch;
  }

  it('acks, starts the run once, and posts the run link', async () => {
    stubApi(202, { runId: 'run_9' });
    try {
      await handleRunSuiteButton(args);
    } finally {
      restore();
    }
    assert.strictEqual(args.ack.mock.callCount(), 1);
    assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 1);
    const posted = args.client.chat.postMessage.mock.calls[0].arguments[0];
    assert.ok(posted.text.includes('/evals/suite/ts_1/runs/run_9'));
  });

  it('replies on the PARENT thread ts, not the button message ts', async () => {
    stubApi(202, { runId: 'run_9' });
    try {
      await handleRunSuiteButton(args);
    } finally {
      restore();
    }
    const posted = args.client.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(posted.thread_ts, '40.0');
  });

  it('falls back to the message ts when it is itself the parent', async () => {
    args.body.message = { ts: '42.0' }; // top-level message, no thread_ts
    stubApi(202, { runId: 'run_9' });
    try {
      await handleRunSuiteButton(args);
    } finally {
      restore();
    }
    assert.strictEqual(args.client.chat.postMessage.mock.calls[0].arguments[0].thread_ts, '42.0');
  });

  it('ignores a second click for the same suite+message (no second run)', async () => {
    stubApi(202, { runId: 'run_9' });
    try {
      await handleRunSuiteButton(args);
      const callsAfterFirst = /** @type {any} */ (globalThis.fetch).mock.callCount();
      await handleRunSuiteButton(args);
      assert.strictEqual(/** @type {any} */ (globalThis.fetch).mock.callCount(), callsAfterFirst);
    } finally {
      restore();
    }
    assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 1);
    assert.strictEqual(args.client.chat.postEphemeral.mock.callCount(), 1);
  });

  it('allows a retry after a failed start', async () => {
    stubApi(500, { code: 'INTERNAL_ERROR', message: 'nope' });
    try {
      await handleRunSuiteButton(args);
      assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 0);
      assert.strictEqual(args.client.chat.postEphemeral.mock.callCount(), 1);
      // The retry must actually start a run, not just find the key cleared.
      stubApi(202, { runId: 'run_9' });
      await handleRunSuiteButton(args);
    } finally {
      restore();
    }
    assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 1);
  });

  it('does NOT allow a retry when the run started but announcing it failed', async () => {
    stubApi(202, { runId: 'run_9' });
    args.client.chat.postMessage = mock.fn(async () => {
      throw new Error('slack down');
    });
    try {
      await handleRunSuiteButton(args);
      const callsAfterFirst = /** @type {any} */ (globalThis.fetch).mock.callCount();
      // A second click must not bill a second run for an already-started one.
      await handleRunSuiteButton(args);
      assert.strictEqual(/** @type {any} */ (globalThis.fetch).mock.callCount(), callsAfterFirst);
    } finally {
      restore();
    }
    assert.strictEqual(args.logger.error.mock.callCount(), 1);
  });

  it('surfaces an error instead of linking a run with no id', async () => {
    stubApi(202, { status: 'running' }); // runId missing
    try {
      await handleRunSuiteButton(args);
    } finally {
      restore();
    }
    assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 0);
    assert.strictEqual(args.client.chat.postEphemeral.mock.callCount(), 1);
  });
});
