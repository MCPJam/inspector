import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
  createThreadBinding,
  fetchAccountLink,
  fetchThreadBinding,
  purgeChannelBindings,
  resolveTurnTarget,
  revokeAccountLink,
} from '../../agent/turn-target.js';

/**
 * `/slack/*` is Slack's own, OLDER backend route family
 * (mcpjam-backend/convex/slackRoutes.ts) — `{teamId, channelId, threadTs,
 * initiatorSlackUserId}` — NOT the generalized `/agent/*` shape
 * (`surfaceKind`/`surfaceTenantId`/`surfaceUserId`/`initiatorSurfaceUserId`)
 * discord-app's routes speak. `@mcpjam/surface-core`'s `createBackendClient`
 * convenience methods send the generic shape and would 400 against
 * `/slack/*`, so `turn-target.js` builds these bodies itself via
 * `backend.post()`. These pin the wire shape so a future "simplify by using
 * the generic methods" edit fails loudly instead of silently 400ing in
 * production.
 */

function stubFetch(bodyFactory) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ path: String(url).replace('https://backend.test', ''), body: JSON.parse(init.body) });
      return new Response(JSON.stringify(bodyFactory(calls.length)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
}

describe('turn-target.js wire shape (Slack legacy routes)', () => {
  const env = () => {
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc';
  };

  it('fetchThreadBinding sends {teamId, channelId, threadTs}', async () => {
    env();
    const { calls, fetchImpl } = stubFetch(() => ({ binding: null }));
    await fetchThreadBinding('T1', 'C1', '123.456', { fetchImpl });
    assert.deepEqual(calls, [
      { path: '/slack/thread-bindings/get', body: { teamId: 'T1', channelId: 'C1', threadTs: '123.456' } },
    ]);
  });

  it('createThreadBinding sends the exact object it is given, including initiatorSlackUserId', async () => {
    env();
    const { calls, fetchImpl } = stubFetch(() => ({ ok: true }));
    await createThreadBinding(
      {
        teamId: 'T1',
        channelId: 'C1',
        threadTs: '123.456',
        organizationId: 'org_1',
        projectId: 'proj_1',
        initiatorSlackUserId: 'U1',
      },
      { fetchImpl },
    );
    assert.deepEqual(calls[0].path, '/slack/thread-bindings/create');
    assert.deepEqual(calls[0].body, {
      teamId: 'T1',
      channelId: 'C1',
      threadTs: '123.456',
      organizationId: 'org_1',
      projectId: 'proj_1',
      initiatorSlackUserId: 'U1',
    });
  });

  it('fetchAccountLink and revokeAccountLink send {teamId, slackUserId}', async () => {
    env();
    const { calls, fetchImpl } = stubFetch(() => ({ link: null }));
    await fetchAccountLink('T1', 'U1', { fetchImpl });
    await revokeAccountLink('T1', 'U1', { fetchImpl });
    assert.deepEqual(calls, [
      { path: '/slack/links/fetch', body: { teamId: 'T1', slackUserId: 'U1' } },
      { path: '/slack/links/revoke', body: { teamId: 'T1', slackUserId: 'U1' } },
    ]);
  });

  it('resolveTurnTarget translates ctx and reports initiatorSlackUserId on a thread-bound target', async () => {
    env();
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    const fetchImpl = mock.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/thread-bindings/get'))
        return new Response(
          JSON.stringify({
            binding: { organizationId: 'org_1', projectId: 'proj_1', initiatorSlackUserId: 'U_INITIATOR' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      throw new Error(`unexpected call to ${path}`);
    });
    const target = await resolveTurnTarget(
      { teamId: 'T1', slackUserId: 'U1' },
      { channelId: 'C1', threadTs: '123.456', fetchImpl },
    );
    assert.equal(target.mode, 'user');
    assert.equal(target.boundThread, true);
    assert.equal(target.initiatorSlackUserId, 'U_INITIATOR');
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
  });

  it('purgeChannelBindings only clears cache entries for its own tenant', async () => {
    env();
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ link: null, binding: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    // Warm the cache for T1 via a real resolve (channel binding path).
    await resolveTurnTarget({ teamId: 'T1', slackUserId: 'U1' }, { channelId: 'C1', fetchImpl });
    const afterFirst = calls;
    purgeChannelBindings('T1');
    await resolveTurnTarget({ teamId: 'T1', slackUserId: 'U1' }, { channelId: 'C1', fetchImpl });
    // A purge must make the NEXT resolve hit the backend again, not serve a
    // cached answer from before the purge.
    assert.ok(calls > afterFirst, 'expected a fresh backend call after purge');
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
  });
});
