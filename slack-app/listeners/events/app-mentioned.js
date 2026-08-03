import { sessionStore } from '../../thread-context/index.js';
import { runAndReply } from './run-and-reply.js';

/**
 * Handle app_mention events and run the agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ client, context, event, logger, say, sayStream, setStatus }) {
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const cleanedText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  if (!cleanedText) {
    await say({
      text: "Hey! I'm the MCPJam agent — mention me with what you'd like tested and I'll turn this thread into an eval suite.",
      thread_ts: threadTs,
    });
    return;
  }

  // Mark the thread engaged so follow-up replies (without a mention) are
  // handled by the message listener.
  sessionStore.setSession(channelId, threadTs, 'engaged');

  await runAndReply({
    client,
    context,
    logger,
    say,
    sayStream,
    setStatus,
    channelId,
    threadTs,
    triggerTs: event.ts,
    isThread: true,
    fallbackText: cleanedText,
  });
}
