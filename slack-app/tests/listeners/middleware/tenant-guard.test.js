import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { clearInstallationCache } from '../../../installations/store.js';
import { tenantGuard } from '../../../listeners/middleware/tenant-guard.js';

function backendResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installationResponse({ isLegacyWorkspace }) {
  return backendResponse({
    ok: true,
    installation: { team: { id: 'T1' }, bot: { token: 'xoxb', userId: 'U_BOT' } },
    botUserId: 'U_BOT',
    isLegacyWorkspace,
  });
}

function argsFor(overrides = {}) {
  return {
    body: { team_id: 'T1' },
    context: {},
    event: { type: 'app_mention', user: 'U1' },
    logger: { warn: mock.fn(), info: mock.fn(), error: mock.fn() },
    next: mock.fn(async () => {}),
    ...overrides,
  };
}

describe('tenantGuard', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    clearInstallationCache();
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.INSPECTOR_SERVICE_TOKEN = 'svc_test';
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('admits the legacy workspace and publishes the tenancy verdict', async () => {
    globalThis.fetch = mock.fn(async () => installationResponse({ isLegacyWorkspace: true }));
    const args = argsFor();
    await tenantGuard(args);
    assert.strictEqual(args.next.mock.callCount(), 1);
    assert.deepStrictEqual(args.context.mcpjamTenancy, {
      isLegacyWorkspace: true,
      botUserId: 'U_BOT',
    });
  });

  it('HARD-DROPS a non-legacy workspace before any agent call', async () => {
    // Until per-user auth ships the bot acts with an org-scoped key belonging
    // to OUR organization. Running another workspace's request with it is a
    // cross-tenant leak, so distribution being live must not mean serving
    // those events.
    globalThis.fetch = mock.fn(async () => installationResponse({ isLegacyWorkspace: false }));
    const args = argsFor();
    await tenantGuard(args);
    assert.strictEqual(args.next.mock.callCount(), 0);
    assert.strictEqual(args.context.mcpjamTenancy, undefined);
  });

  it('drops events from a workspace with no active installation', async () => {
    globalThis.fetch = mock.fn(async () => backendResponse({ ok: true, installation: null }));
    const args = argsFor();
    await tenantGuard(args);
    assert.strictEqual(args.next.mock.callCount(), 0);
  });

  it('drops (for Slack to retry) rather than proceeding when the backend is down', async () => {
    // The dangerous alternative is running the turn anyway under whatever
    // credentials happen to be in env.
    globalThis.fetch = mock.fn(async () => backendResponse({ error: 'down' }, 500));
    const args = argsFor();
    await tenantGuard(args);
    assert.strictEqual(args.next.mock.callCount(), 0);
    assert.strictEqual(args.logger.warn.mock.callCount(), 1);
  });

  it('lets lifecycle events through WITHOUT a tenancy lookup', async () => {
    // app_uninstalled is how a workspace tells us it revoked us. Gating it on
    // an active installation would make the revoke unreachable — and gating a
    // non-legacy workspace's uninstall would leak its row forever.
    globalThis.fetch = mock.fn(async () => {
      throw new Error('the guard must not call the backend for lifecycle events');
    });
    for (const type of ['app_uninstalled', 'tokens_revoked']) {
      const args = argsFor({ event: { type }, payload: { type } });
      await tenantGuard(args);
      assert.strictEqual(args.next.mock.callCount(), 1, `${type} should pass through`);
    }
  });

  it('drops a payload with no resolvable tenant without calling the backend', async () => {
    globalThis.fetch = mock.fn(async () => {
      throw new Error('should not be reached');
    });
    const args = argsFor({ body: {}, event: { type: 'message' }, context: {} });
    await tenantGuard(args);
    assert.strictEqual(args.next.mock.callCount(), 0);
  });
});
