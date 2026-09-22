import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchThreadHistory } from '../../agent/thread-history.js';

/**
 * `fetchThreadHistory` must return RAW rows for the core's turn-runner to
 * normalize exactly once — see turn-runner.js's contract comment. Returning
 * pre-normalized `{role, content}` rows here would silently erase the
 * assistant's own turns from its history the same way it did for Discord
 * before that adapter was fixed.
 */

describe('fetchThreadHistory', () => {
  it('uses conversations.replies for a thread, limit 200', async () => {
    const calls = [];
    const client = {
      conversations: {
        replies: async (args) => {
          calls.push(['replies', args]);
          return { messages: [{ ts: '1.0', text: 'hi', user: 'U1' }] };
        },
        history: async () => {
          throw new Error('must not be called for a thread');
        },
      },
    };
    const rows = await fetchThreadHistory(client, {
      channelId: 'C1',
      threadTs: '1.0',
      triggerTs: '2.0',
      isThread: true,
      botUserId: 'BOT',
      limit: 50,
    });
    assert.deepEqual(calls, [['replies', { channel: 'C1', ts: '1.0', limit: 200 }]]);
    assert.deepEqual(rows, [{ content: 'hi', timestampMs: 1000, authorId: 'U1', isBot: false }]);
  });

  it('uses conversations.history for a DM and reverses it (newest-first from Slack)', async () => {
    const client = {
      conversations: {
        replies: async () => {
          throw new Error('must not be called for a DM');
        },
        history: async () => ({
          messages: [
            { ts: '3.0', text: 'third', user: 'U1' },
            { ts: '2.0', text: 'second', bot_id: 'B1' },
            { ts: '1.0', text: 'first', user: 'U1' },
          ],
        }),
      },
    };
    const rows = await fetchThreadHistory(client, {
      channelId: 'D1',
      threadTs: '3.0',
      triggerTs: '3.0',
      isThread: false,
      botUserId: 'BOT',
      limit: 50,
    });
    assert.deepEqual(
      rows.map((row) => row.content),
      ['first', 'second', 'third'],
    );
    assert.equal(rows[1].isBot, true);
    // Raw rows, not normalized ones — no `role` key.
    assert.equal('role' in rows[0], false);
  });

  it('a bot message is identified by bot_id OR matching the botUserId', async () => {
    const client = {
      conversations: {
        replies: async () => ({
          messages: [
            { ts: '1.0', text: 'from a human', user: 'U1' },
            { ts: '2.0', text: 'from bot_id', bot_id: 'B1' },
            { ts: '3.0', text: 'from botUserId match', user: 'BOT' },
          ],
        }),
        history: async () => ({ messages: [] }),
      },
    };
    const rows = await fetchThreadHistory(client, {
      channelId: 'C1',
      threadTs: '1.0',
      triggerTs: '9.0',
      isThread: true,
      botUserId: 'BOT',
      limit: 50,
    });
    assert.deepEqual(
      rows.map((row) => row.isBot),
      [false, true, true],
    );
  });
});
