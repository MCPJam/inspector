import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { SessionStore } from '../../thread-context/store.js';

describe('SessionStore', () => {
  let store;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('stores and retrieves a session', () => {
    store.setSession('T1', 'C1', 'ts-1', 'sid-abc');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-1'), 'sid-abc');
  });

  it('returns null for missing key', () => {
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-99'), null);
  });

  it('keeps different threads independent', () => {
    store.setSession('T1', 'C1', 'ts-1', 'sid-1');
    store.setSession('T1', 'C1', 'ts-2', 'sid-2');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-1'), 'sid-1');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-2'), 'sid-2');
  });

  it('isolates identical channel+thread ids across workspaces', () => {
    // Slack channel ids are unique only WITHIN a workspace, so two tenants
    // can genuinely present the same (channel, thread) pair. Team T2 must not
    // see T1's engaged thread — that would make the bot answer unaddressed
    // messages in a channel it was never invited to.
    store.setSession('T1', 'C1', 'ts-1', 'engaged');
    assert.strictEqual(store.getSession('T2', 'C1', 'ts-1'), null);
    store.setSession('T2', 'C1', 'ts-1', 'engaged-elsewhere');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-1'), 'engaged');
    assert.strictEqual(store.getSession('T2', 'C1', 'ts-1'), 'engaged-elsewhere');
  });

  it('refuses to key a session without a team id', () => {
    assert.throws(() => store.setSession('', 'C1', 'ts-1', 'sid'), /requires a teamId/);
    assert.throws(() => store.getSession('', 'C1', 'ts-1'), /requires a teamId/);
  });

  it('clearTeam drops only that workspace threads', () => {
    store.setSession('T1', 'C1', 'ts-1', 'sid-1');
    store.setSession('T1', 'C2', 'ts-2', 'sid-2');
    store.setSession('T2', 'C1', 'ts-1', 'sid-3');
    store.clearTeam('T1');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-1'), null);
    assert.strictEqual(store.getSession('T1', 'C2', 'ts-2'), null);
    assert.strictEqual(store.getSession('T2', 'C1', 'ts-1'), 'sid-3');
  });

  it('expires entries after TTL', async () => {
    const shortStore = new SessionStore(0);
    shortStore.setSession('T1', 'C1', 'ts-1', 'sid-abc');
    // Need a tiny delay to ensure Date.now() advances past the stored timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(shortStore.getSession('T1', 'C1', 'ts-1'), null);
  });

  it('evicts oldest entries when max is exceeded', () => {
    const smallStore = new SessionStore(86400, 2);
    smallStore.setSession('T1', 'C1', 'ts-1', 'sid-1');
    smallStore.setSession('T1', 'C1', 'ts-2', 'sid-2');
    smallStore.setSession('T1', 'C1', 'ts-3', 'sid-3');
    assert.strictEqual(smallStore.getSession('T1', 'C1', 'ts-1'), null);
    assert.strictEqual(smallStore.getSession('T1', 'C1', 'ts-2'), 'sid-2');
    assert.strictEqual(smallStore.getSession('T1', 'C1', 'ts-3'), 'sid-3');
  });

  it('overwrites existing key', () => {
    store.setSession('T1', 'C1', 'ts-1', 'sid-old');
    store.setSession('T1', 'C1', 'ts-1', 'sid-new');
    assert.strictEqual(store.getSession('T1', 'C1', 'ts-1'), 'sid-new');
  });
});
