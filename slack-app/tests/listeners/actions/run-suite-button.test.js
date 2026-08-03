import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleRunSuiteButton, startedRunKeys } from '../../../listeners/actions/run-suite-button.js';

describe('handleRunSuiteButton', () => {
  /** @type {any} */
  let args;
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    startedRunKeys.clear();
    process.env.MCPJAM_API_KEY = 'sk_test';
    process.env.MCPJAM_PROJECT_ID = 'p1';
    process.env.MCPJAM_BASE_URL = 'https://example.test';
    realFetch = globalThis.fetch;
    args = {
      ack: mock.fn(async () => {}),
      body: { channel: { id: 'C1' }, message: { ts: '42.0' } },
      action: { value: 'ts_1' },
      context: { userId: 'U1' },
      logger: { error: mock.fn() },
      client: {
        chat: {
          postMessage: mock.fn(async () => ({ ok: true })),
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
    } finally {
      restore();
    }
    assert.strictEqual(args.client.chat.postMessage.mock.callCount(), 0);
    assert.strictEqual(startedRunKeys.size, 0); // retry permitted
    assert.strictEqual(args.client.chat.postEphemeral.mock.callCount(), 1);
  });
});
