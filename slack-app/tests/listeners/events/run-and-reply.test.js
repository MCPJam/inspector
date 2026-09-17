import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpjamApiError } from '../../../agent/mcpjam-client.js';
import { backend } from '../../../installations/backend-client.js';
import { runAndReply } from '../../../listeners/events/run-and-reply.js';

test('pending durable turns escape without logging or posting a failure', async (t) => {
  const names = ['MCPJAM_CONVEX_HTTP_URL', 'SLACK_SERVICE_TOKEN', 'MCPJAM_SLACK_SERVICE_TOKEN'];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = name.endsWith('URL') ? 'https://backend.test' : 'test';
  t.after(() =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }),
  );
  const pending = new McpjamApiError('Still running', { code: 'AGENT_JOB_PENDING', details: { jobId: 'job' } });
  t.mock.method(backend, 'post', async () => {
    throw pending;
  });
  const errors = [];
  const replies = [];
  await assert.rejects(
    runAndReply({
      ctx: { teamId: 'T', slackUserId: 'U' },
      channelId: 'C',
      threadTs: '1',
      client: {},
      context: {},
      logger: { error: (error) => errors.push(error) },
      say: async (reply) => replies.push(reply),
    }),
    (error) => error === pending,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(replies, []);
});
