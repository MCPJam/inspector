import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { dedupe, EventDedupe, KeyedQueue, normalizeThreadMessages, runTurnForEvent } from '../../agent/turn-runner.js';

// Mirrors the server contract in server/routes/v1/agent.ts.
const MAX_MESSAGE_BYTES = 8_192;
const MAX_TOTAL_MESSAGE_BYTES = 98_304;
const utf8 = (/** @type {string} */ s) => Buffer.byteLength(s, 'utf8');

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

  it('release() allows an immediate re-claim', () => {
    const dedupe = new EventDedupe();
    dedupe.claim('C1:1');
    dedupe.release('C1:1');
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

  it('enforces the per-message BYTE cap, not just characters', () => {
    // 4,000 emoji = 4,000 chars (under the 8,000 char cap) but 16,000 bytes.
    const [message] = normalizeThreadMessages([{ ts: '1.0', user: 'U1', text: '😀'.repeat(4_000) }], {
      ...opts,
      triggerTs: '999.0',
    });
    assert.ok(utf8(message.content) <= MAX_MESSAGE_BYTES, `got ${utf8(message.content)} bytes`);
    assert.ok(message.content.endsWith('…'));
    // Truncation must not leave a broken surrogate pair behind.
    assert.ok(!/[\uD800-\uDFFF]/.test(message.content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')));
  });

  it('drops oldest messages until the history fits the aggregate budget', () => {
    // 40 × ~6 KB of multibyte text = ~240 KB, well past the 96 KB total.
    const raw = Array.from({ length: 40 }, (_, i) => ({
      ts: `${i + 1}.0`,
      user: 'U1',
      text: `${i}-${'é'.repeat(3_000)}`,
    }));
    const messages = normalizeThreadMessages(raw, { ...opts, triggerTs: '999.0' });
    const total = messages.reduce((sum, m) => sum + utf8(m.content), 0);
    assert.ok(total <= MAX_TOTAL_MESSAGE_BYTES, `got ${total} bytes`);
    assert.ok(messages.length > 0);
    // The NEWEST messages survive — the trigger must always be included.
    assert.ok(messages[messages.length - 1].content.startsWith('39-'));
  });

  it('keeps at least one message even if it alone is large', () => {
    const messages = normalizeThreadMessages([{ ts: '1.0', user: 'U1', text: 'é'.repeat(5_000) }], {
      ...opts,
      triggerTs: '999.0',
    });
    assert.strictEqual(messages.length, 1);
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

describe('runTurnForEvent', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    dedupe.clear();
    process.env.MCPJAM_API_KEY = 'sk_test';
    process.env.MCPJAM_PROJECT_ID = 'p1';
    process.env.MCPJAM_BASE_URL = 'https://stub.test';
    realFetch = globalThis.fetch;
  });

  function stubApi(order) {
    globalThis.fetch = async () => {
      order.push('api-call');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ reply: 'ok', toolCalls: [], createdResources: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }

  const client = /** @type {any} */ ({
    conversations: { history: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hello' }] }) },
  });

  function trigger(ts, order) {
    return runTurnForEvent({
      client,
      channelId: 'D1',
      threadTs: ts,
      triggerTs: ts,
      isThread: false,
      botUserId: 'B1',
      fallbackText: 'hi',
      onResult: async () => {
        order.push(`post-${ts}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        order.push(`post-done-${ts}`);
      },
    });
  }

  it('serializes rapid top-level DMs, reply included', async () => {
    // Each DM has its own ts, so a ts-keyed queue would not serialize them —
    // and posting outside the queue would let turn 2 start before turn 1's
    // answer landed. Both are the duplicate-suite hazard.
    const order = [];
    stubApi(order);
    try {
      await Promise.all([trigger('100.0', order), trigger('101.0', order)]);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepStrictEqual(order, [
      'api-call',
      'post-100.0',
      'post-done-100.0',
      'api-call',
      'post-101.0',
      'post-done-101.0',
    ]);
  });

  it('refuses a duplicate delivery of the same event', async () => {
    const order = [];
    stubApi(order);
    try {
      assert.strictEqual(await trigger('200.0', order), true);
      assert.strictEqual(await trigger('200.0', order), false);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(order.filter((step) => step === 'api-call').length, 1);
  });
});
