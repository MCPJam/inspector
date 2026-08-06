import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  CHANNEL_BINDING_CACHE_MAX_ENTRIES,
  channelBindingCacheSize,
  clearChannelBindingCache,
  getCachedChannelBinding,
  purgeChannelBindings,
  setCachedChannelBinding,
} from '../../agent/binding-cache.js';
import { fetchChannelBinding } from '../../agent/turn-target.js';

/**
 * The binding cache exists to keep a backend round trip off Slack's 3-second
 * ack budget. What these pin:
 *
 *   1. NEGATIVES ARE CACHED. Most channels have no binding, so a cache that
 *      skipped misses would do nothing for the traffic that needs it most.
 *      This is a deliberate departure from `installations/store.js`, where a
 *      cached miss would lock out a workspace that just installed.
 *   2. `null` (no binding) and a cache MISS are different answers, and the
 *      read API has to be able to say which it is.
 *   3. Entries expire, and the map stays bounded.
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('channel binding cache', () => {
  beforeEach(() => {
    clearChannelBindingCache();
  });

  it('distinguishes a cached "no binding" from a miss', () => {
    assert.strictEqual(getCachedChannelBinding('T1', 'C1'), undefined);
    setCachedChannelBinding('T1', 'C1', null);
    assert.strictEqual(getCachedChannelBinding('T1', 'C1'), null);
  });

  it('keys on the workspace as well as the channel', () => {
    // Channel ids are only unique within a workspace.
    setCachedChannelBinding('T1', 'C1', { organizationId: 'org_a', projectId: 'p_a' });
    assert.strictEqual(getCachedChannelBinding('T2', 'C1'), undefined);
  });

  it('expires an entry at its TTL', (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    try {
      setCachedChannelBinding('T1', 'C1', { organizationId: 'org_a', projectId: 'p_a' });
      t.mock.timers.tick(61_000);
      assert.strictEqual(getCachedChannelBinding('T1', 'C1'), undefined);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('stays bounded under unbounded channels', () => {
    for (let i = 0; i < CHANNEL_BINDING_CACHE_MAX_ENTRIES + 50; i += 1) {
      setCachedChannelBinding('T1', `C${i}`, null);
    }
    assert.ok(channelBindingCacheSize() <= CHANNEL_BINDING_CACHE_MAX_ENTRIES);
  });
});

describe('fetchChannelBinding read-through', () => {
  let realFetch;
  let realEnv;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Restored in afterEach: these persist for the whole process otherwise, so
    // a later case asserting the missing-config path would silently see a
    // configured backend and pass for the wrong reason.
    realEnv = {
      url: process.env.MCPJAM_CONVEX_HTTP_URL,
      token: process.env.SLACK_SERVICE_TOKEN,
    };
    clearChannelBindingCache();
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc_test';
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realEnv.url === undefined) delete process.env.MCPJAM_CONVEX_HTTP_URL;
    else process.env.MCPJAM_CONVEX_HTTP_URL = realEnv.url;
    if (realEnv.token === undefined) delete process.env.SLACK_SERVICE_TOKEN;
    else process.env.SLACK_SERVICE_TOKEN = realEnv.token;
  });

  it('asks the backend once, then serves from cache', async () => {
    const fetchMock = mock.fn(async () =>
      jsonResponse({ ok: true, binding: { organizationId: 'org_a', projectId: 'p_a' } }),
    );
    globalThis.fetch = fetchMock;

    const first = await fetchChannelBinding('T1', 'C1');
    const second = await fetchChannelBinding('T1', 'C1');
    assert.deepStrictEqual(first, second);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it('caches a NEGATIVE answer too', async () => {
    // The common case by far. Not caching it would leave the hot path
    // unprotected for every unbound channel.
    const fetchMock = mock.fn(async () => jsonResponse({ ok: true, binding: null }));
    globalThis.fetch = fetchMock;

    assert.strictEqual(await fetchChannelBinding('T1', 'C1'), null);
    assert.strictEqual(await fetchChannelBinding('T1', 'C1'), null);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it('caches the degraded answer from a backend that has no such route', async () => {
    const fetchMock = mock.fn(async () => jsonResponse({ error: 'nope' }, 404));
    globalThis.fetch = fetchMock;

    assert.strictEqual(await fetchChannelBinding('T1', 'C1'), null);
    assert.strictEqual(await fetchChannelBinding('T1', 'C1'), null);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it('COALESCES concurrent reads into one round trip', async () => {
    // The cold-start burst: two turns in the same channel at once. Without
    // coalescing they both miss, both fetch, and the slower answer lands last
    // — which is how a just-changed binding gets overwritten by its old value.
    const fetchMock = mock.fn(async () =>
      jsonResponse({ ok: true, binding: { organizationId: 'org_a', projectId: 'p_a' } }),
    );
    globalThis.fetch = fetchMock;

    const [a, b] = await Promise.all([fetchChannelBinding('T1', 'C1'), fetchChannelBinding('T1', 'C1')]);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(fetchMock.mock.callCount(), 1);
  });

  it('PURGES a workspace on uninstall, so a reconnect does not reuse its routing', async () => {
    const fetchMock = mock.fn(async () =>
      jsonResponse({ ok: true, binding: { organizationId: 'org_a', projectId: 'p_a' } }),
    );
    globalThis.fetch = fetchMock;

    await fetchChannelBinding('T1', 'C1');
    purgeChannelBindings('T1');
    assert.strictEqual(getCachedChannelBinding('T1', 'C1'), undefined);
    await fetchChannelBinding('T1', 'C1');
    assert.strictEqual(fetchMock.mock.callCount(), 2);
  });

  it('does NOT cache an outage', async () => {
    // A 500 is not an answer, so it must not be remembered as one.
    const fetchMock = mock.fn(async () => jsonResponse({ error: 'boom' }, 500));
    globalThis.fetch = fetchMock;

    await assert.rejects(() => fetchChannelBinding('T1', 'C1'));
    assert.strictEqual(getCachedChannelBinding('T1', 'C1'), undefined);
  });
});
