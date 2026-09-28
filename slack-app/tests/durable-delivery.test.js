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
  await assert.doesNotReject(deliverDurableReply(client, handle, result));
  await deliverDurableReply(client, handle, result);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], updates[1]);
  assert.equal(updates[0].ts, handle.ts);
});

test('recovery retries a pending acknowledgement using the original reply handle', async (t) => {
  const { startDurableDeliveryRecovery } = await import('../agent/durable-delivery.js');
  const { WebClient } = await import('@slack/web-api');
  const previousUrl = process.env.MCPJAM_CONVEX_HTTP_URL;
  const previousToken = process.env.SLACK_SERVICE_TOKEN;
  process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
  process.env.SLACK_SERVICE_TOKEN = 'test';
  t.after(() => {
    if (previousUrl === undefined) delete process.env.MCPJAM_CONVEX_HTTP_URL;
    else process.env.MCPJAM_CONVEX_HTTP_URL = previousUrl;
    if (previousToken === undefined) delete process.env.SLACK_SERVICE_TOKEN;
    else process.env.SLACK_SERVICE_TOKEN = previousToken;
  });
  let recover;
  t.mock.method(globalThis, 'setInterval', (callback) => {
    recover = callback;
    return { unref() {} };
  });
  const updates = [];
  t.mock.method(WebClient.prototype, 'apiCall', async (_method, args) => {
    updates.push(args);
    return { ok: true };
  });
  let acknowledgements = 0;
  let pending = true;
  t.mock.method(backend, 'post', async (path) => {
    if (path === '/slack/turns/pending')
      return {
        deliveries: pending
          ? [{ teamId: 'T', jobId: 'job', replyHandle: { channel: 'C', ts: '1.2' }, result: { reply: 'Done' } }]
          : [],
      };
    if (path === '/slack/installations/fetch') return { installation: { bot: { token: 'xoxb-test' } } };
    if (path === '/slack/turns/delivered') {
      if (++acknowledgements === 1) throw new Error('Lost ack');
      pending = false;
    }
  });
  const errors = [];
  startDurableDeliveryRecovery({ error: (error) => errors.push(error) });
  await new Promise(setImmediate);
  assert.equal(pending, true);
  recover();
  await new Promise(setImmediate);
  assert.equal(pending, false);
  assert.equal(acknowledgements, 2);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], updates[1]);
  assert.deepEqual(errors, []);
});
