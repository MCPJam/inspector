import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { clearChannelBindingCache } from '../../agent/binding-cache.js';
import { getConfig, McpjamApiError } from '../../agent/mcpjam-client.js';
import { resolveTurnTarget } from '../../agent/turn-target.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Answers the three lookups `resolveTurnTarget` makes, in ladder order:
 * thread binding, channel binding, account link.
 *
 * `channelBindingStatus` lets a case answer 404 instead — the shape an older
 * backend returns for a route it does not serve.
 */
function stubBackend({ binding = null, channelBinding = null, link = null, channelBindingStatus = 200 } = {}) {
  const calls = [];
  globalThis.fetch = mock.fn(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.endsWith('/thread-bindings/get')) return jsonResponse({ ok: true, binding });
    if (path.endsWith('/channel-bindings/get')) {
      return channelBindingStatus === 200
        ? jsonResponse({ ok: true, binding: channelBinding })
        : jsonResponse({ error: 'not found' }, channelBindingStatus);
    }
    if (path.endsWith('/links/fetch')) return jsonResponse({ ok: true, link });
    throw new Error(`unexpected fetch to ${path}`);
  });
  return calls;
}

const CTX = { teamId: 'T1', slackUserId: 'U1' };
const LEGACY_CTX = { ...CTX, isLegacyWorkspace: true };

describe('resolveTurnTarget', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // The binding cache is module-global with a 60 s TTL; a case that left an
    // entry behind would silently decide the next one's target.
    clearChannelBindingCache();
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc_test';
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    delete process.env.MCPJAM_PROJECT_ID;
  });

  it('a THREAD BINDING wins over the replier’s own default project', async () => {
    // The whole point of the binding: without it a thread would drift between
    // projects as different people replied, and a suite would land somewhere
    // nobody expected.
    stubBackend({
      binding: { organizationId: 'org_a', projectId: 'proj_thread', initiatorSlackUserId: 'U_ALICE' },
      link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'user');
    assert.strictEqual(target.projectId, 'proj_thread');
    assert.strictEqual(target.boundThread, true);
    assert.strictEqual(target.initiatorSlackUserId, 'U_ALICE');
  });

  it('does not even look up the link when a binding applies', async () => {
    const calls = stubBackend({
      binding: { organizationId: 'org_a', projectId: 'proj_thread', initiatorSlackUserId: 'U_ALICE' },
    });
    await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.ok(!calls.some((path) => path.endsWith('/links/fetch')));
  });

  it('falls back to the replier’s default project for a new conversation', async () => {
    stubBackend({ link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' } });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.deepStrictEqual(
      { mode: target.mode, projectId: target.projectId, organizationId: target.organizationId },
      { mode: 'user', projectId: 'proj_mine', organizationId: 'org_b' },
    );
  });

  it('asks a linked user with no default to pick one — not an error', async () => {
    stubBackend({ link: { organizationId: 'org_b', defaultProjectId: null } });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'needs_project');
  });

  it('asks an unlinked user to connect', async () => {
    stubBackend({});
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'unlinked');
  });

  it('a LINKED user in the legacy workspace acts as themselves, not on the shared key', async () => {
    // Otherwise linking would be pointless for our own team: they would keep
    // acting through the org-wide key they were supposed to stop using.
    process.env.MCPJAM_PROJECT_ID = 'proj_env';
    stubBackend({ link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' } });
    const target = await resolveTurnTarget(LEGACY_CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'user');
    assert.strictEqual(target.projectId, 'proj_mine');
  });

  it('an UNLINKED user in the legacy workspace still works on the shared key', async () => {
    // Our own team must not be locked out mid-migration.
    process.env.MCPJAM_PROJECT_ID = 'proj_env';
    stubBackend({});
    const target = await resolveTurnTarget(LEGACY_CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'legacy');
    assert.strictEqual(target.projectId, 'proj_env');
  });

  it('a CHANNEL BINDING beats the replier’s own default project in the same org', async () => {
    // The whole value of the binding: an org sets a channel up once, and
    // nobody who speaks there has to have configured anything.
    stubBackend({
      channelBinding: { organizationId: 'org_a', projectId: 'proj_channel' },
      link: { organizationId: 'org_a', defaultProjectId: 'proj_mine' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C_BOUND', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'user');
    assert.strictEqual(target.projectId, 'proj_channel');
    assert.strictEqual(target.boundChannel, true);
    // The binding decides the PROJECT; the speaker still acts as themselves.
    assert.strictEqual(target.organizationId, 'org_a');
  });

  it('ignores a CHANNEL BINDING owned by another org', async () => {
    stubBackend({
      channelBinding: { organizationId: 'org_a', projectId: 'proj_channel' },
      link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C_BOUND', threadTs: 'ts-1' });
    assert.deepStrictEqual(
      {
        mode: target.mode,
        projectId: target.projectId,
        organizationId: target.organizationId,
      },
      { mode: 'user', projectId: 'proj_mine', organizationId: 'org_b' },
    );
    assert.notStrictEqual(target.boundChannel, true);
  });

  it('a THREAD binding still beats a CHANNEL binding', async () => {
    // An engaged thread must not be moved out from under itself when an admin
    // later binds the channel it lives in.
    stubBackend({
      binding: { organizationId: 'org_a', projectId: 'proj_thread', initiatorSlackUserId: 'U_ALICE' },
      channelBinding: { organizationId: 'org_a', projectId: 'proj_channel' },
      link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C_BOUND', threadTs: 'ts-1' });
    assert.strictEqual(target.projectId, 'proj_thread');
    assert.strictEqual(target.boundThread, true);
    assert.notStrictEqual(target.boundChannel, true);
  });

  it('offers an UNLINKED user the connect flow even in a bound channel', async () => {
    // A bound channel is often where someone meets the bot for the first time.
    // Running them as `user` would send them to an inevitable 401 whose reply
    // is a sentence; `unlinked` is what renders the connect button.
    stubBackend({
      channelBinding: { organizationId: 'org_a', projectId: 'proj_channel' },
      link: null,
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C_BOUND', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'unlinked');
  });

  it('does not look up the link when a THREAD binding applies', async () => {
    // The thread binding still short-circuits: its initiator already resolved.
    const calls = stubBackend({
      binding: { organizationId: 'org_a', projectId: 'proj_thread', initiatorSlackUserId: 'U_ALICE' },
    });
    await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.ok(!calls.some((path) => path.endsWith('/links/fetch')));
  });

  it('falls back to the ORG default only when the user has none', async () => {
    stubBackend({
      link: { organizationId: 'org_b', defaultProjectId: null, orgDefaultProjectId: 'proj_org' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'user');
    assert.strictEqual(target.projectId, 'proj_org');
    assert.strictEqual(target.orgDefault, true);
  });

  it('never lets the ORG default override the user’s own choice', async () => {
    // The org default removes a setup step; it does not overrule someone who
    // already decided where their turns land.
    stubBackend({
      link: { organizationId: 'org_b', defaultProjectId: 'proj_mine', orgDefaultProjectId: 'proj_org' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.projectId, 'proj_mine');
    assert.notStrictEqual(target.orgDefault, true);
  });

  it('still asks for a project when neither default exists', async () => {
    stubBackend({ link: { organizationId: 'org_b', defaultProjectId: null, orgDefaultProjectId: null } });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'needs_project');
  });

  it('works against an OLD backend whose link payload has no orgDefaultProjectId', async () => {
    // Mixed-version safety in the direction that actually happens: the bot
    // deploys before the backend does.
    stubBackend({ link: { organizationId: 'org_b', defaultProjectId: null } });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'needs_project');
  });

  it('DEGRADES to no binding when the backend does not serve the route', async () => {
    // A 404 means the deployment predates the endpoint, which is an answer.
    stubBackend({
      channelBindingStatus: 404,
      link: { organizationId: 'org_b', defaultProjectId: 'proj_mine' },
    });
    const target = await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' });
    assert.strictEqual(target.mode, 'user');
    assert.strictEqual(target.projectId, 'proj_mine');
  });

  it('still FAILS on a real backend outage rather than reporting "no binding"', async () => {
    // Silently reading an outage as "unbound" would land the turn in the
    // speaker's own project — a wrong answer dressed up as a normal one.
    globalThis.fetch = mock.fn(async (url) => {
      const path = String(url);
      if (path.endsWith('/thread-bindings/get')) return jsonResponse({ ok: true, binding: null });
      if (path.endsWith('/channel-bindings/get')) return jsonResponse({ error: 'boom' }, 500);
      throw new Error(`unexpected fetch to ${path}`);
    });
    await assert.rejects(() => resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' }));
  });

  it('skips the backend entirely when per-user auth is not configured', async () => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    process.env.MCPJAM_PROJECT_ID = 'proj_env';
    globalThis.fetch = mock.fn(async () => {
      throw new Error('should not be reached');
    });
    assert.strictEqual((await resolveTurnTarget(LEGACY_CTX, { channelId: 'C1', threadTs: 'ts-1' })).mode, 'legacy');
    assert.strictEqual((await resolveTurnTarget(CTX, { channelId: 'C1', threadTs: 'ts-1' })).mode, 'unlinked');
  });
});

describe('getConfig credential modes', () => {
  beforeEach(() => {
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    process.env.MCPJAM_SLACK_SERVICE_TOKEN = 'slk_test';
    process.env.MCPJAM_API_KEY = 'sk_legacy';
    process.env.MCPJAM_PROJECT_ID = 'proj_env';
  });

  afterEach(() => {
    delete process.env.MCPJAM_SLACK_SERVICE_TOKEN;
  });

  it("user mode presents the bot's token plus the ACTOR's identity headers", async () => {
    // The bot never holds a user token: the server resolves the identity from
    // these headers, so a compromised bot cannot harvest portable org JWTs.
    const config = getConfig({ ...CTX, mode: 'user', projectId: 'proj_mine' });
    assert.strictEqual(config.apiKey, 'slk_test');
    assert.strictEqual(config.projectId, 'proj_mine');
    assert.deepStrictEqual(config.headers, {
      'x-mcpjam-slack-team-id': 'T1',
      'x-mcpjam-slack-user-id': 'U1',
    });
  });

  it('user mode refuses to run without a resolved project', async () => {
    assert.throws(
      () => getConfig({ ...CTX, mode: 'user' }),
      (error) => {
        assert.strictEqual(error.code, 'NO_PROJECT');
        return true;
      },
    );
  });

  it('legacy mode releases the shared key ONLY for the legacy workspace', async () => {
    const ok = getConfig({ ...LEGACY_CTX, mode: 'legacy' });
    assert.strictEqual(ok.apiKey, 'sk_legacy');
    assert.deepStrictEqual(ok.headers, {});

    assert.throws(() => getConfig({ ...CTX, mode: 'legacy' }), McpjamApiError);
  });

  it('fails closed when the mode is absent entirely', async () => {
    // A new call path that forgot to resolve a target must not inherit our
    // organization's credentials.
    assert.throws(
      () => getConfig(CTX),
      (error) => {
        assert.strictEqual(error.code, 'UNAUTHORIZED');
        return true;
      },
    );
  });
});

describe('friendly error copy', () => {
  it('sends an unauthorized user to connect, not to an admin', () => {
    const error = new McpjamApiError('nope', { code: 'UNAUTHORIZED' });
    assert.match(error.friendlyMessage, /connect your MCPJam account/i);
  });

  it('explains a 403 as a project-access problem', () => {
    // The common cause is a thread bound to a project the replier can't reach.
    const error = new McpjamApiError('nope', { code: 'FORBIDDEN' });
    assert.match(error.friendlyMessage, /access to the project this thread/i);
  });

  it('never reports a backend outage as an auth problem', () => {
    // Otherwise the user re-links an account that was already fine.
    const error = new McpjamApiError('down', { code: 'SERVER_UNREACHABLE' });
    assert.doesNotMatch(error.friendlyMessage, /connect|link/i);
  });
});
