import assert from 'node:assert';
import { describe, it } from 'node:test';

import { EventDedupe, KeyedQueue, normalizeThreadMessages } from '../../agent/turn-runner.js';

describe('EventDedupe', () => {
  it('claims a key once and rejects repeats while in flight', () => {
    const dedupe = new EventDedupe();
    assert.strictEqual(dedupe.claim('C1:1'), true);
    assert.strictEqual(dedupe.claim('C1:1'), false);
  });

  it('keeps rejecting a completed key within the TTL (delayed Slack retry)', () => {
    let clock = 1_000;
    const dedupe = new EventDedupe({ ttlMs: 100, now: () => clock });
    dedupe.claim('C1:1');
    dedupe.complete('C1:1');
    clock += 50; // retry arrives after completion, inside the TTL
    assert.strictEqual(dedupe.claim('C1:1'), false);
  });

  it('expires completed keys after the TTL', () => {
    let clock = 1_000;
    const dedupe = new EventDedupe({ ttlMs: 100, now: () => clock });
    dedupe.claim('C1:1');
    dedupe.complete('C1:1');
    clock += 200;
    assert.strictEqual(dedupe.claim('C1:1'), true);
  });

  it('never expires an in-flight key', () => {
    let clock = 1_000;
    const dedupe = new EventDedupe({ ttlMs: 100, now: () => clock });
    dedupe.claim('C1:1');
    clock += 10_000;
    assert.strictEqual(dedupe.claim('C1:1'), false);
  });
});

describe('KeyedQueue', () => {
  it('serializes jobs on the same key', async () => {
    const queue = new KeyedQueue();
    const order = [];
    /** @type {() => void} */
    let releaseFirst = () => {};
    const first = queue.enqueue('t1', async () => {
      order.push('first-start');
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    const second = queue.enqueue('t1', async () => {
      order.push('second-start');
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(order, ['first-start']); // second waits
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ['first-start', 'first-end', 'second-start']);
  });

  it('runs different keys concurrently', async () => {
    const queue = new KeyedQueue();
    const order = [];
    let releaseA = () => {};
    const a = queue.enqueue('a', async () => {
      await new Promise((resolve) => {
        releaseA = resolve;
      });
      order.push('a');
    });
    const b = queue.enqueue('b', async () => {
      order.push('b');
    });
    await b;
    assert.deepStrictEqual(order, ['b']); // b did not wait for a
    releaseA();
    await a;
  });

  it('keeps running after a failed job and surfaces the error', async () => {
    const queue = new KeyedQueue();
    await assert.rejects(
      queue.enqueue('t1', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    const result = await queue.enqueue('t1', async () => 'ok');
    assert.strictEqual(result, 'ok');
  });

  it('cleans up settled chains', async () => {
    const queue = new KeyedQueue();
    await queue.enqueue('t1', async () => 'done');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.strictEqual(queue.chains.size, 0);
  });
});

describe('normalizeThreadMessages', () => {
  const opts = { botUserId: 'B_BOT', triggerTs: '100.000' };

  it('maps bot messages to assistant and humans to user', () => {
    const messages = normalizeThreadMessages(
      [
        { ts: '1.0', user: 'U1', text: 'test my server' },
        { ts: '2.0', bot_id: 'B99', text: 'sure thing' },
        { ts: '3.0', user: 'B_BOT', text: 'also me' },
      ],
      opts,
    );
    assert.deepStrictEqual(
      messages.map((m) => m.role),
      ['user', 'assistant', 'assistant'],
    );
  });

  it('filters out messages newer than the trigger', () => {
    const messages = normalizeThreadMessages(
      [
        { ts: '99.0', user: 'U1', text: 'in scope' },
        { ts: '100.000', user: 'U1', text: 'the trigger' },
        { ts: '101.0', user: 'U2', text: 'next turn' },
      ],
      opts,
    );
    assert.strictEqual(messages.length, 2);
    assert.ok(!messages.some((m) => m.content.includes('next turn')));
  });

  it('truncates oversized messages and caps the count', () => {
    const raw = Array.from({ length: 60 }, (_, i) => ({
      ts: `${i + 1}.0`,
      user: 'U1',
      text: i === 59 ? 'x'.repeat(10_000) : `msg ${i}`,
    }));
    const messages = normalizeThreadMessages(raw, { ...opts, triggerTs: '999.0' });
    assert.strictEqual(messages.length, 50);
    const last = messages[messages.length - 1];
    assert.ok(last.content.length <= 8_000);
    assert.ok(last.content.endsWith('…'));
  });

  it('drops empty messages', () => {
    const messages = normalizeThreadMessages(
      [
        { ts: '1.0', user: 'U1', text: '   ' },
        { ts: '2.0', user: 'U1', text: 'real' },
      ],
      opts,
    );
    assert.strictEqual(messages.length, 1);
  });
});
