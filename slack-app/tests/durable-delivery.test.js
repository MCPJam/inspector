import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverDurableReply } from '../agent/durable-delivery.js';
import { backend } from '../installations/backend-client.js';

test('a lost delivery acknowledgement reuses the saved Slack message', async (t) => {
  const updates = [];
  const client = {
    chat: {
      update: async (message) => {
        updates.push(message);
      },
    },
  };
  let calls = 0;
  t.mock.method(backend, 'post', async (path, body) => {
    assert.equal(path, '/slack/turns/delivered');
    assert.deepEqual(body, { jobId: 'job-1' });
    if (++calls === 1) throw new Error('acknowledgement lost');
  });
  const handle = { channel: 'C1', ts: '123.45' };
  const result = { jobId: 'job-1', reply: 'Saved the cases.', createdResources: [], proposedActions: [] };
  await assert.rejects(deliverDurableReply(client, handle, result), /acknowledgement lost/);
  await deliverDurableReply(client, handle, result);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], updates[1]);
  assert.equal(updates[0].ts, handle.ts);
});
