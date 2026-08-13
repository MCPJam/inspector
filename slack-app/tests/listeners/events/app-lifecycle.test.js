import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { getCachedChannelBinding, purgeChannelBindings, setCachedChannelBinding } from '../../../agent/turn-target.js';
import { clearInstallationCache, installationCacheSize, resolveInstallation } from '../../../installations/store.js';
import { handleAppUninstalled, handleTokensRevoked } from '../../../listeners/events/app-lifecycle.js';
import { sessionStore } from '../../../thread-context/index.js';

function backendResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Answers fetch with an install, and records revoke calls. */
function stubBackend({ botUserId = 'U_BOT', revokeStatus = 200 } = {}) {
  const revoked = [];
  globalThis.fetch = mock.fn(async (url, init) => {
    const path = String(url);
    const body = JSON.parse(String(init?.body));
    if (path.endsWith('/revoke')) {
      revoked.push(body.teamId);
      return revokeStatus === 200
        ? backendResponse({ ok: true, revoked: true })
        : backendResponse({ error: 'nope' }, revokeStatus);
    }
    return backendResponse({
      ok: true,
      installation: { team: { id: body.teamId }, bot: { token: 'xoxb', userId: botUserId } },
      botUserId,
      isLegacyWorkspace: true,
    });
  });
  return revoked;
}

const logger = () => ({ warn: mock.fn(), info: mock.fn(), error: mock.fn() });

describe('installation lifecycle', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    clearInstallationCache();
    purgeChannelBindings('T1');
    purgeChannelBindings('T2');
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc_test';
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('app_uninstalled revokes and purges cache + engaged threads', async () => {
    const revoked = stubBackend();
    await resolveInstallation('T1');
    sessionStore.set('T1', 'C1', 'ts-1', 'engaged');
    sessionStore.set('T2', 'C1', 'ts-1', 'engaged');

    await handleAppUninstalled({ body: { team_id: 'T1' }, context: {}, event: {}, logger: logger() });

    assert.deepStrictEqual(revoked, ['T1']);
    assert.strictEqual(installationCacheSize(), 0);
    assert.strictEqual(sessionStore.get('T1', 'C1', 'ts-1'), null);
    assert.strictEqual(sessionStore.get('T2', 'C1', 'ts-1'), 'engaged', 'other tenants untouched');
  });

  it('purges locally even when the backend revoke fails', async () => {
    // The workspace has already withdrawn consent. This process must stop
    // using the token immediately; the durable revoke can be retried.
    stubBackend({ revokeStatus: 500 });
    await resolveInstallation('T1');
    const log = logger();

    await handleAppUninstalled({ body: { team_id: 'T1' }, context: {}, event: {}, logger: log });

    assert.strictEqual(installationCacheSize(), 0);
    assert.strictEqual(log.error.mock.callCount(), 1);
  });

  it('tokens_revoked revokes ONLY when our bot token is named', async () => {
    const revoked = stubBackend({ botUserId: 'U_BOT' });
    await resolveInstallation('T1');

    await handleTokensRevoked({
      body: { team_id: 'T1' },
      context: {},
      event: { tokens: { bot: ['U_BOT'] } },
      logger: logger(),
    });
    assert.deepStrictEqual(revoked, ['T1']);
  });

  it('tokens_revoked for ANOTHER bot token leaves the installation alone', async () => {
    const revoked = stubBackend({ botUserId: 'U_BOT' });
    await resolveInstallation('T1');

    await handleTokensRevoked({
      body: { team_id: 'T1' },
      context: {},
      event: { tokens: { bot: ['U_SOMEONE_ELSE'] } },
      logger: logger(),
    });
    assert.deepStrictEqual(revoked, [], 'must not revoke on another app’s bot token');
    assert.strictEqual(installationCacheSize(), 1, 'cache stays warm');
  });

  it('tokens_revoked naming only USER tokens does not touch the installation', async () => {
    // A user revoking their own token must not take the workspace's bot
    // offline for everyone.
    const revoked = stubBackend();
    await resolveInstallation('T1');

    await handleTokensRevoked({
      body: { team_id: 'T1' },
      context: {},
      event: { tokens: { oauth: ['U1'] } },
      logger: logger(),
    });
    assert.deepStrictEqual(revoked, []);
    assert.strictEqual(installationCacheSize(), 1);
  });

  it('does not guess a durable revoke when the installation cannot be resolved', async () => {
    // …but it DOES drop the re-fetchable caches. A binding that survives here
    // can route the workspace's next turn by the routing of an install that
    // may have just been revoked; re-reading it costs one round trip.
    // Engaged threads are the exception: a session is not re-fetchable, and
    // this path is reachable by a transient backend error on an event that was
    // never about our bot.
    setCachedChannelBinding('T1', 'C1', { organizationId: 'org_a', projectId: 'p_a' });
    setCachedChannelBinding('T2', 'C1', { organizationId: 'org_b', projectId: 'p_b' });
    sessionStore.set('T1', 'C1', 'ts-1', 'engaged');

    const revoked = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/revoke')) {
        revoked.push(JSON.parse(String(init?.body)).teamId);
        return backendResponse({ ok: true });
      }
      return backendResponse({ error: 'down' }, 500);
    });

    await handleTokensRevoked({
      body: { team_id: 'T1' },
      context: {},
      event: { tokens: { bot: ['U_BOT'] } },
      logger: logger(),
    });
    assert.deepStrictEqual(revoked, [], 'unknown whether OUR token was revoked — do not guess');
    assert.strictEqual(getCachedChannelBinding('T1', 'C1'), undefined, 'bindings purged');
    assert.deepStrictEqual(
      getCachedChannelBinding('T2', 'C1'),
      { organizationId: 'org_b', projectId: 'p_b' },
      'other workspaces untouched',
    );
    assert.strictEqual(sessionStore.get('T1', 'C1', 'ts-1'), 'engaged', 'engaged threads survive');
  });
});
