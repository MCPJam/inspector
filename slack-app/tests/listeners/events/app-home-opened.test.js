import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { handleAppHomeOpened } from '../../../listeners/events/app-home-opened.js';

describe('handleAppHomeOpened', () => {
  let fakeClient;
  let fakeContext;
  let fakeLogger;

  beforeEach(() => {
    fakeClient = {
      views: { publish: mock.fn(async () => ({ ok: true })) },
      assistant: { threads: { setSuggestedPrompts: mock.fn(async () => ({ ok: true })) } },
    };
    fakeContext = { userId: 'U123' };
    fakeLogger = { error: mock.fn() };
  });

  it('publishes the home view when event.tab === "home"', async () => {
    const event = { tab: 'home', channel: 'D123' };
    await handleAppHomeOpened({ client: fakeClient, event, context: fakeContext, logger: fakeLogger });
    assert.strictEqual(fakeClient.views.publish.mock.callCount(), 1);
    const callArgs = fakeClient.views.publish.mock.calls[0].arguments[0];
    assert.strictEqual(callArgs.user_id, 'U123');
    assert.strictEqual(callArgs.view.type, 'home');
    assert.strictEqual(fakeClient.assistant.threads.setSuggestedPrompts.mock.callCount(), 0);
  });

  it('sets suggested prompts when event.tab === "messages"', async () => {
    const event = { tab: 'messages', channel: 'D123' };
    await handleAppHomeOpened({ client: fakeClient, event, context: fakeContext, logger: fakeLogger });
    assert.strictEqual(fakeClient.assistant.threads.setSuggestedPrompts.mock.callCount(), 1);
    const callArgs = fakeClient.assistant.threads.setSuggestedPrompts.mock.calls[0].arguments[0];
    assert.strictEqual(callArgs.channel_id, 'D123');
    assert.ok(Array.isArray(callArgs.prompts));
    assert.strictEqual(fakeClient.views.publish.mock.callCount(), 0);
  });

  it('logs error when views.publish fails', async () => {
    fakeClient.views.publish = mock.fn(async () => {
      throw new Error('API error');
    });
    const event = { tab: 'home', channel: 'D123' };
    await handleAppHomeOpened({ client: fakeClient, event, context: fakeContext, logger: fakeLogger });
    assert.strictEqual(fakeLogger.error.mock.callCount(), 1);
  });
});
