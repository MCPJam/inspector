import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mintConnectUrl } from '../../agent/connect-link.js';
import { InstallationBackendError } from '../../installations/backend-client.js';

/**
 * `/api/slack/link/session` (server/routes/slack-link/index.ts) is Slack's
 * own, OLDER account-linking bridge — a completely separate OAuth flow from
 * the generic `/api/surface-link/session` discord-app calls — and it expects
 * `{teamId, slackUserId}`, not the generic `{surfaceKind, surfaceTenantId,
 * surfaceUserId}` body `@mcpjam/surface-core`'s `mintConnectUrl` sends by
 * default. These pin the wire shape and credential this adapter must keep
 * sending.
 */

const CTX = { teamId: 'T1', slackUserId: 'U1' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('connect-link.js wire shape and credential (Slack legacy bridge)', () => {
  it('posts {teamId, slackUserId} to /api/slack/link/session with the slk_ credential', async () => {
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    let request;
    const fetchImpl = async (url, init) => {
      request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
      return jsonResponse({ ok: true, url: 'https://api.test/api/slack/link/start?s=abc' });
    };
    const url = await mintConnectUrl(CTX, { fetchImpl });
    assert.equal(url, 'https://api.test/api/slack/link/start?s=abc');
    assert.equal(request.url, 'https://api.test/api/slack/link/session');
    assert.equal(request.headers.Authorization, 'Bearer slk_test');
    assert.deepEqual(request.body, { teamId: 'T1', slackUserId: 'U1' });
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
  });

  it('throws a named CONFIG error when MCPJAM_SLACK_SERVICE_TOKEN is unset — never the environment-root token', async () => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl: async () => jsonResponse({}) }), (error) => {
      assert.ok(error instanceof InstallationBackendError);
      assert.equal(error.code, 'CONFIG');
      return true;
    });
  });

  it('rejects a minted url that is not on a configured origin', async () => {
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    const fetchImpl = async () => jsonResponse({ ok: true, url: 'https://evil.example.com/steal' });
    await assert.rejects(mintConnectUrl(CTX, { fetchImpl }), /unconfigured origin/);
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
  });

  it('accepts a url on SLACK_LINK_PUBLIC_ORIGIN even when it differs from the API origin', async () => {
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    process.env.SLACK_LINK_PUBLIC_ORIGIN = 'https://links.test';
    const fetchImpl = async () => jsonResponse({ ok: true, url: 'https://links.test/api/slack/link/start?s=abc' });
    const url = await mintConnectUrl(CTX, { fetchImpl });
    assert.equal(url, 'https://links.test/api/slack/link/start?s=abc');
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_BASE_URL;
    delete process.env.SLACK_LINK_PUBLIC_ORIGIN;
  });
});
