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

test('a failure after onStart updates the existing placeholder', async (t) => {
  const names = [
    'DURABLE_AGENT_TURNS_ENABLED',
    'MCPJAM_SLACK_SERVICE_TOKEN',
    'MCPJAM_CONVEX_HTTP_URL',
    'SLACK_SERVICE_TOKEN',
    'MCPJAM_PROJECT_ID',
  ];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) delete process.env[name];
  process.env.DURABLE_AGENT_TURNS_ENABLED = 'true';
  process.env.MCPJAM_PROJECT_ID = 'p1';
  t.after(() =>
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    }),
  );
  const posts = [];
  const updates = [];
  await runAndReply({
    ctx: { teamId: 'T-placeholder', slackUserId: 'U', isLegacyWorkspace: true },
    channelId: 'C',
    threadTs: '2',
    triggerTs: '3',
    isThread: true,
    client: {
      conversations: {
        replies: async () => {
          throw new Error('history failed');
        },
      },
      chat: { update: async (message) => updates.push(message) },
    },
    context: {},
    logger: { error() {}, warn() {} },
    setStatus: async () => {},
    say: async (message) => {
      posts.push(message);
      return { ts: 'placeholder' };
    },
  });
  assert.equal(posts.length, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].ts, 'placeholder');
  assert.match(updates[0].text, /Something went wrong/);
});
