import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { McpjamApiError, runAgentTurn, startSuiteRun } from '../../agent/mcpjam-client.js';

/** Every entry point is tenant-scoped now; one context serves the whole file. */
const CTX = { teamId: 'T1', slackUserId: 'U1' };

/** @param {number} status @param {unknown} body */
function fakeFetch(status, body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('mcpjam-client', () => {
  beforeEach(() => {
    process.env.MCPJAM_API_KEY = 'sk_test';
    process.env.MCPJAM_PROJECT_ID = 'p1';
    process.env.MCPJAM_BASE_URL = 'https://example.test';
  });

  it('returns the turn result with defaults for missing fields', async () => {
    const result = await runAgentTurn([{ role: 'user', content: 'hi' }], CTX, {
      fetchImpl: fakeFetch(200, { reply: 'hello' }),
    });
    assert.deepStrictEqual(result, { reply: 'hello', toolCalls: [], createdResources: [] });
  });

  it('maps RATE_LIMITED errors to a capacity message', async () => {
    await assert.rejects(
      runAgentTurn([{ role: 'user', content: 'hi' }], CTX, {
        fetchImpl: fakeFetch(429, { code: 'RATE_LIMITED', message: 'too many turns' }),
      }),
      (error) => {
        assert.ok(error instanceof McpjamApiError);
        assert.strictEqual(error.code, 'RATE_LIMITED');
        assert.ok(error.friendlyMessage.includes('capacity'));
        return true;
      },
    );
  });

  it('maps TIMEOUT errors to a friendly message', async () => {
    await assert.rejects(
      runAgentTurn([{ role: 'user', content: 'hi' }], CTX, {
        fetchImpl: fakeFetch(504, { code: 'TIMEOUT', message: 'turn exceeded limit' }),
      }),
      (error) => {
        assert.strictEqual(error.code, 'TIMEOUT');
        assert.ok(error.friendlyMessage.includes('longer'));
        return true;
      },
    );
  });

  it('reports a mid-body abort as a TIMEOUT, not an empty success', async () => {
    // Headers arrive 200 OK, then the body stalls until the abort fires.
    // Swallowing that would hand the user a cheerful empty reply.
    const stalledBody = /** @type {any} */ (
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      })
    );
    await assert.rejects(runAgentTurn([{ role: 'user', content: 'hi' }], CTX, { fetchImpl: stalledBody }), (error) => {
      assert.strictEqual(error.code, 'TIMEOUT');
      return true;
    });
  });

  it('still lets the status decide when the body simply is not JSON', async () => {
    const htmlErrorPage = /** @type {any} */ (
      async () =>
        new Response('<html>502 upstream</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })
    );
    await assert.rejects(
      runAgentTurn([{ role: 'user', content: 'hi' }], CTX, { fetchImpl: htmlErrorPage }),
      (error) => {
        assert.strictEqual(error.status, 502);
        return true;
      },
    );
  });

  it('fails with CONFIG when env is missing', async () => {
    delete process.env.MCPJAM_API_KEY;
    await assert.rejects(runAgentTurn([{ role: 'user', content: 'hi' }], CTX), (error) => {
      assert.strictEqual(error.code, 'CONFIG');
      return true;
    });
  });

  it('startSuiteRun builds the run deep link', async () => {
    const run = await startSuiteRun('ts_1', CTX, {
      fetchImpl: fakeFetch(202, { runId: 'run_9', suiteId: 'ts_1', status: 'running' }),
    });
    assert.strictEqual(run.url, 'https://example.test/evals/suite/ts_1/runs/run_9?project=p1');
  });

  it('deep links use MCPJAM_APP_URL when it differs from the API host', async () => {
    process.env.MCPJAM_APP_URL = 'http://localhost:5173';
    try {
      const run = await startSuiteRun('ts_1', CTX, {
        fetchImpl: fakeFetch(202, { runId: 'run_9' }),
      });
      assert.strictEqual(run.url, 'http://localhost:5173/evals/suite/ts_1/runs/run_9?project=p1');
    } finally {
      delete process.env.MCPJAM_APP_URL;
    }
  });
});
