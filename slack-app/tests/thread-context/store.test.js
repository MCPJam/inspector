import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { SessionStore } from '../../thread-context/store.js';

describe('SessionStore', () => {
  let store;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('stores and retrieves a session', () => {
    store.setSession('C1', 'T1', 'sid-abc');
    assert.strictEqual(store.getSession('C1', 'T1'), 'sid-abc');
  });

  it('returns null for missing key', () => {
    assert.strictEqual(store.getSession('C1', 'T99'), null);
  });

  it('keeps different threads independent', () => {
    store.setSession('C1', 'T1', 'sid-1');
    store.setSession('C1', 'T2', 'sid-2');
    assert.strictEqual(store.getSession('C1', 'T1'), 'sid-1');
    assert.strictEqual(store.getSession('C1', 'T2'), 'sid-2');
  });

  it('expires entries after TTL', async () => {
    const shortStore = new SessionStore(0);
    shortStore.setSession('C1', 'T1', 'sid-abc');
    // Need a tiny delay to ensure Date.now() advances past the stored timestamp
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(shortStore.getSession('C1', 'T1'), null);
  });

  it('evicts oldest entries when max is exceeded', () => {
    const smallStore = new SessionStore(86400, 2);
    smallStore.setSession('C1', 'T1', 'sid-1');
    smallStore.setSession('C1', 'T2', 'sid-2');
    smallStore.setSession('C1', 'T3', 'sid-3');
    assert.strictEqual(smallStore.getSession('C1', 'T1'), null);
    assert.strictEqual(smallStore.getSession('C1', 'T2'), 'sid-2');
    assert.strictEqual(smallStore.getSession('C1', 'T3'), 'sid-3');
  });

  it('overwrites existing key', () => {
    store.setSession('C1', 'T1', 'sid-old');
    store.setSession('C1', 'T1', 'sid-new');
    assert.strictEqual(store.getSession('C1', 'T1'), 'sid-new');
  });
});
