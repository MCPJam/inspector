import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { InstallationBackendError } from '../../installations/backend-client.js';
import {
  clearInstallationCache,
  convexInstallationStore,
  installationCacheSize,
  purgeInstallation,
  resolveInstallation,
} from '../../installations/store.js';

/** A minimal but realistic Bolt Installation. */
function installationFor(teamId, botUserId = 'U_BOT') {
  return {
    team: { id: teamId, name: `Team ${teamId}` },
    bot: { token: 'xoxb-secret', scopes: ['chat:write'], userId: botUserId },
    appId: 'A1',
    tokenType: 'bot',
    isEnterpriseInstall: false,
    authVersion: 'v2',
  };
}

function backendResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('installation store', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    clearInstallationCache();
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc_test';
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('caches a successful lookup so events do not each pay a round trip', async () => {
    const calls = mock.fn(async () =>
      backendResponse({
        ok: true,
        installation: installationFor('T1'),
        botUserId: 'U_BOT',
        isLegacyWorkspace: true,
      }),
    );
    globalThis.fetch = calls;

    const first = await resolveInstallation('T1');
    const second = await resolveInstallation('T1');
    assert.strictEqual(calls.mock.callCount(), 1, 'second lookup should hit the cache');
    assert.strictEqual(first?.isLegacyWorkspace, true);
    assert.deepStrictEqual(first, second);
  });

  it('purgeInstallation makes revocation immediate, not TTL-delayed', async () => {
    // This is the whole reason the cache is safe. If a purge did not drop the
    // entry synchronously, a revoked workspace would keep being served for
    // the full TTL and "revocation is instant" would be false.
    let installed = true;
    globalThis.fetch = mock.fn(async () =>
      backendResponse(
        installed
          ? { ok: true, installation: installationFor('T1'), botUserId: 'U_BOT', isLegacyWorkspace: true }
          : { ok: true, installation: null },
      ),
    );

    assert.ok(await resolveInstallation('T1'));
    installed = false;
    // Without the purge this would still answer from cache.
    purgeInstallation('T1');
    assert.strictEqual(await resolveInstallation('T1'), null);
  });

  it('does not cache a negative result', async () => {
    // A workspace that installs seconds after a miss must work immediately.
    let installed = false;
    const calls = mock.fn(async () =>
      backendResponse(
        installed
          ? { ok: true, installation: installationFor('T1'), botUserId: 'U_BOT', isLegacyWorkspace: false }
          : { ok: true, installation: null },
      ),
    );
    globalThis.fetch = calls;

    assert.strictEqual(await resolveInstallation('T1'), null);
    assert.strictEqual(installationCacheSize(), 0);
    installed = true;
    assert.ok(await resolveInstallation('T1'));
    assert.strictEqual(calls.mock.callCount(), 2);
  });

  it('keeps two workspaces cached independently', async () => {
    globalThis.fetch = mock.fn(async (_url, init) => {
      const teamId = JSON.parse(String(init?.body)).teamId;
      return backendResponse({
        ok: true,
        installation: installationFor(teamId, `U_BOT_${teamId}`),
        botUserId: `U_BOT_${teamId}`,
        isLegacyWorkspace: teamId === 'T1',
      });
    });

    const a = await resolveInstallation('T1');
    const b = await resolveInstallation('T2');
    assert.strictEqual(a?.isLegacyWorkspace, true);
    assert.strictEqual(b?.isLegacyWorkspace, false);

    purgeInstallation('T1');
    assert.strictEqual(installationCacheSize(), 1, 'purging T1 must not evict T2');
  });

  it('a purge DURING a lookup is not undone by that lookup', async () => {
    // Without a generation check the in-flight fetch's `cache.set` re-inserts
    // the revoked grant, and every event for the next 5 minutes is served
    // with a token the workspace just killed.
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    globalThis.fetch = mock.fn(async () => {
      await gate;
      return backendResponse({
        ok: true,
        installation: installationFor('T1'),
        botUserId: 'U_BOT',
        isLegacyWorkspace: true,
      });
    });

    const inflight = resolveInstallation('T1');
    // The uninstall lands while the lookup is still open.
    purgeInstallation('T1');
    release();
    await inflight;

    assert.strictEqual(installationCacheSize(), 0, 'the purged grant must not be re-cached');
  });

  it('surfaces a backend outage as an error, never as "not installed"', async () => {
    // Returning null here would look like an uninstall: Bolt would drop the
    // event and the workspace would be told to reinstall over a blip.
    globalThis.fetch = mock.fn(async () => backendResponse({ error: 'boom' }, 503));
    await assert.rejects(resolveInstallation('T1'), InstallationBackendError);
  });

  it('fetchInstallation throws for a workspace with no active install', async () => {
    globalThis.fetch = mock.fn(async () => backendResponse({ ok: true, installation: null }));
    await assert.rejects(
      convexInstallationStore.fetchInstallation({ teamId: 'T_GONE' }, undefined, undefined),
      /No active MCPJam installation/,
    );
  });

  it('refuses enterprise-install queries instead of answering with a team token', async () => {
    // org_deploy_enabled is off, so an enterprise query means a shape we do
    // not support. Answering it with SOME workspace's token would be acting
    // as a tenant nobody authorized.
    await assert.rejects(
      convexInstallationStore.fetchInstallation({ isEnterpriseInstall: true, enterpriseId: 'E1' }),
      /enterprise grid/i,
    );
    await assert.rejects(
      convexInstallationStore.storeInstallation({ ...installationFor('T1'), isEnterpriseInstall: true }),
      /enterprise grid/i,
    );
  });

  it('storeInstallation persists the whole object and purges the previous grant', async () => {
    let stored = null;
    globalThis.fetch = mock.fn(async (url, init) => {
      const path = String(url);
      const body = JSON.parse(String(init?.body));
      if (path.endsWith('/upsert')) {
        stored = body;
        return backendResponse({ ok: true, created: true });
      }
      return backendResponse({
        ok: true,
        installation: installationFor('T1'),
        botUserId: 'U_BOT',
        isLegacyWorkspace: true,
      });
    });

    // Warm the cache with the PREVIOUS grant, then reinstall.
    await resolveInstallation('T1');
    assert.strictEqual(installationCacheSize(), 1);

    await convexInstallationStore.storeInstallation(installationFor('T1'), undefined, undefined);
    assert.strictEqual(stored.teamId, 'T1');
    assert.strictEqual(stored.botUserId, 'U_BOT');
    // The full object round-trips, not a column projection — Bolt reads
    // fields we do not model.
    assert.strictEqual(stored.installation.bot.token, 'xoxb-secret');
    assert.strictEqual(stored.installation.authVersion, 'v2');
    assert.strictEqual(installationCacheSize(), 0, 'a reinstall must invalidate the cached token');
  });

  it('rejects an installation with no bot user id', async () => {
    // Without it the app cannot tell its OWN messages from a human's when
    // re-reading a thread, so every turn would feed the model its own replies.
    const broken = installationFor('T1');
    delete broken.bot.userId;
    await assert.rejects(convexInstallationStore.storeInstallation(broken), /bot user id/);
  });
});
