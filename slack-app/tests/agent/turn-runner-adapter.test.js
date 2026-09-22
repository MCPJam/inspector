import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { replayQueueKey } from '../../agent/turn-runner.js';

/**
 * The core's own default queue key (`threadId || "root"`) cannot tell a real
 * thread from a DM for Slack: `threadTs` is always populated (it is the
 * message's own ts for a top-level DM), unlike Discord's `threadId`, which is
 * `undefined` outside a thread. This is exactly what `runTurnForEvent`'s
 * `queueKey` override exists for — these pin the derivation `runTurnForEvent`
 * passes through it.
 */

describe('replayQueueKey', () => {
  it('keys a thread reply on its parent ts, not the individual message', () => {
    const ctx = { teamId: 'T1', slackUserId: 'U1' };
    const a = replayQueueKey(ctx, { channelId: 'C1', threadTs: '100.0', isThread: true });
    const b = replayQueueKey(ctx, { channelId: 'C1', threadTs: '100.0', isThread: true });
    assert.equal(a, b);
    assert.equal(a, 'T1:thread:C1:100.0');
  });

  it("keys a DM on the channel alone — NOT on threadTs, which is the message's own ts", () => {
    const ctx = { teamId: 'T1', slackUserId: 'U1' };
    const first = replayQueueKey(ctx, { channelId: 'D1', threadTs: '100.0', isThread: false });
    const second = replayQueueKey(ctx, { channelId: 'D1', threadTs: '200.0', isThread: false });
    // Two rapid DM messages have DIFFERENT threadTs (each is its own ts) but
    // MUST serialize against each other — keying on threadTs here would give
    // each one its own queue and serialize nothing.
    assert.equal(first, second);
    assert.equal(first, 'T1:dm:D1');
  });

  it('keeps two workspaces independent even with identical channel/thread ids', () => {
    const a = replayQueueKey({ teamId: 'T1' }, { channelId: 'C1', threadTs: '1.0', isThread: true });
    const b = replayQueueKey({ teamId: 'T2' }, { channelId: 'C1', threadTs: '1.0', isThread: true });
    assert.notEqual(a, b);
  });
});
