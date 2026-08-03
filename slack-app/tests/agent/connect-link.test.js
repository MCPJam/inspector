import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { mintConnectUrl } from '../../agent/connect-link.js';
import { InstallationBackendError } from '../../installations/backend-client.js';

const CTX = { teamId: 'T1', slackUserId: 'U1' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('mintConnectUrl', () => {
  beforeEach(() => {
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    process.env.INSPECTOR_SERVICE_TOKEN = 'svc_test';
  });

  afterEach(() => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
  });

  it('asks the bridge for a URL scoped to THIS user', async () => {
    // An identity mix-up here would hand one person a link that binds
    // another's Slack account, so the payload is worth pinning.
    let seen;
    const fetchImpl = mock.fn(async (url, init) => {
      seen = { url: String(url), init };
      return jsonResponse({ ok: true, url: 'https://api.test/api/slack/link/start?s=abc' });
    });

    const url = await mintConnectUrl(CTX, { fetchImpl });
    assert.strictEqual(url, 'https://api.test/api/slack/link/start?s=abc');
    assert.strictEqual(seen.url, 'https://api.test/api/slack/link/session');
    assert.deepStrictEqual(JSON.parse(seen.init.body), { teamId: 'T1', slackUserId: 'U1' });
  });

  it('authenticates with the service token header, not a bearer', async () => {
    // `lib/serviceToken.ts` reserves the bearer slot for the delegated flow;
    // new callers must use the header form.
    let headers;
    const fetchImpl = mock.fn(async (_url, init) => {
      headers = init.headers;
      return jsonResponse({ ok: true, url: 'https://api.test/x' });
    });
    await mintConnectUrl(CTX, { fetchImpl });
    assert.strictEqual(headers['x-inspector-service-token'], 'svc_test');
    assert.strictEqual(headers.Authorization, undefined);
  });

  it('refuses to fabricate a URL when the bridge returns none', async () => {
    const fetchImpl = mock.fn(async () => jsonResponse({ ok: true }));
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), InstallationBackendError);
  });

  it('surfaces a bridge error rather than a broken link', async () => {
    const fetchImpl = mock.fn(async () => jsonResponse({ message: 'nope' }, 500));
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), InstallationBackendError);
  });

  it('reports a timeout as TIMEOUT', async () => {
    const fetchImpl = mock.fn(async (_url, init) => {
      await new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
        // Never resolves on its own — the abort is the only exit.
        setTimeout(resolve, 60_000).unref?.();
      });
      return jsonResponse({ ok: true, url: 'x' });
    });
    // A 1ms deadline drives the real abort path in milliseconds. Waiting out
    // the production 10s would add ten seconds to every `npm run verify`.
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl, timeoutMs: 1 }), (error) => {
      assert.ok(error instanceof InstallationBackendError);
      assert.strictEqual(error.code, 'TIMEOUT');
      return true;
    });
  });

  // The minted URL is rendered as a Block Kit button on the bot's App Home.
  // Slack links whatever it is given, so a bad value is not a cosmetic bug: an
  // off-origin one is a phishing link carrying our bot's name.
  for (const [label, url] of [
    ['an empty string', ''],
    ['a relative path', '/api/slack/link/start?s=abc'],
    ['a protocol-relative URL', '//evil.test/api/slack/link/start'],
    ['a different origin', 'https://evil.test/api/slack/link/start?s=abc'],
    ['a matching host on a different port', 'https://api.test:8443/api/slack/link/start'],
    ['plain http on a non-loopback host', 'http://api.test/api/slack/link/start'],
    ['a javascript: URL', 'javascript:alert(1)'],
  ]) {
    it(`rejects ${label} instead of rendering it`, async () => {
      const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url }));
      await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), InstallationBackendError);
    });
  }

  it('does not leak the link URL into the rejection message', async () => {
    // The URL is a single-use credential for a named user's link flow, and
    // this message reaches the bot's logs.
    const secret = 'https://evil.test/start?s=super-secret-session';
    const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url: secret }));
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), (error) => {
      assert.ok(!error.message.includes('super-secret-session'));
      return true;
    });
  });

  it('allows plain http on loopback so local dev still works', async () => {
    process.env.MCPJAM_BASE_URL = 'http://localhost:3001';
    const fetchImpl = mock.fn(async () =>
      jsonResponse({ ok: true, url: 'http://localhost:3001/api/slack/link/start' }),
    );
    assert.strictEqual(await mintConnectUrl(CTX, { fetchImpl }), 'http://localhost:3001/api/slack/link/start');
  });

  it('fails closed without a service token', async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    await assert.rejects(mintConnectUrl(CTX), (error) => {
      assert.strictEqual(error.code, 'CONFIG');
      return true;
    });
  });
});
