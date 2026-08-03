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
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    // The optional origins widen the allowlist, so each test starts from a
    // known-narrow one and opts in explicitly.
    delete process.env.SLACK_LINK_PUBLIC_ORIGIN;
    delete process.env.CLI_AUTH_PUBLIC_ORIGIN;
    delete process.env.MCPJAM_SLACK_LINK_ORIGIN;
    delete process.env.MCPJAM_APP_URL;
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.SLACK_LINK_PUBLIC_ORIGIN;
    delete process.env.CLI_AUTH_PUBLIC_ORIGIN;
    delete process.env.MCPJAM_SLACK_LINK_ORIGIN;
    delete process.env.MCPJAM_APP_URL;
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

  it("authenticates with the bot's own slk_ bearer, never the inspector root token", async () => {
    // The bridge verifies the SAME `slk_` credential the bot presents on
    // /api/v1. The inspector's environment-root service token must not exist
    // in the bot's environment at all — that separation is the blast-radius
    // boundary the credential split exists for.
    let headers;
    const fetchImpl = mock.fn(async (_url, init) => {
      headers = init.headers;
      return jsonResponse({ ok: true, url: 'https://api.test/x' });
    });
    await mintConnectUrl(CTX, { fetchImpl });
    assert.strictEqual(headers.Authorization, 'Bearer slk_test');
    assert.strictEqual(headers['x-inspector-service-token'], undefined);
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
    // Reads as our host to a human scanning the string; `URL` resolves the
    // host to `evil.test`. Comparing parsed origins is what catches it.
    ['a userinfo-confused host', 'https://api.test@evil.test/api/slack/link/start'],
  ]) {
    it(`rejects ${label} instead of rendering it`, async () => {
      const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url }));
      // Pinned to the URL check, not merely to the error class: `mintConnectUrl`
      // raises the same class for config, network and timeout failures, so a
      // regression that rejected for an unrelated reason would look green.
      await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), (error) => {
        assert.ok(error instanceof InstallationBackendError);
        assert.match(error.message, /connect link/i);
        return true;
      });
    });
  }

  it('accepts the bridge origin when it differs from the API origin', async () => {
    // The bridge mints from SLACK_LINK_PUBLIC_ORIGIN, a DIFFERENT setting from
    // the one the bot calls. Requiring them to match would make linking
    // impossible on every split-origin deployment, local dev included.
    process.env.SLACK_LINK_PUBLIC_ORIGIN = 'https://link.test';
    const url = 'https://link.test/api/slack/link/start?s=abc';
    const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url }));
    assert.strictEqual(await mintConnectUrl(CTX, { fetchImpl }), url);
  });

  it('accepts the bridge CLI_AUTH_PUBLIC_ORIGIN fallback', async () => {
    // `server/routes/slack-link/index.ts` resolves its public origin as
    // `SLACK_LINK_PUBLIC_ORIGIN ?? CLI_AUTH_PUBLIC_ORIGIN`. A deployment that
    // sets only the documented fallback mints from THIS origin, so leaving it
    // out of the allowlist rejected every link such a deployment ever issued.
    process.env.CLI_AUTH_PUBLIC_ORIGIN = 'https://link.test';
    const url = 'https://link.test/api/slack/link/start?s=abc';
    const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url }));
    assert.strictEqual(await mintConnectUrl(CTX, { fetchImpl }), url);
  });

  it('still refuses an origin nobody configured', async () => {
    // The allowlist widens with configuration, never with the response.
    process.env.SLACK_LINK_PUBLIC_ORIGIN = 'https://link.test';
    const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url: 'https://evil.test/api/slack/link/start' }));
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), InstallationBackendError);
  });

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

  // Every loopback spelling the implementation accepts, so a later edit cannot
  // quietly drop one and break a local setup that used it.
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    it(`allows plain http on ${host} so local dev still works`, async () => {
      const origin = `http://${host}:3001`;
      process.env.MCPJAM_BASE_URL = origin;
      const url = `${origin}/api/slack/link/start`;
      const fetchImpl = mock.fn(async () => jsonResponse({ ok: true, url }));
      assert.strictEqual(await mintConnectUrl(CTX, { fetchImpl }), url);
    });
  }

  it('fails closed without a service token', async () => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    await assert.rejects(mintConnectUrl(CTX), (error) => {
      assert.strictEqual(error.code, 'CONFIG');
      return true;
    });
  });
});
