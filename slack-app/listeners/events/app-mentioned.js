import { tryslackContextFrom } from '../../agent/slack-context.js';
import { sessionStore } from '../../thread-context/index.js';
import { runAndReply } from './run-and-reply.js';

/**
 * Handle app_mention events and run the agent.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_mention'>} args
 * @returns {Promise<void>}
 */
export async function handleAppMentioned({ body, client, context, event, logger, say, sayStream, setStatus }) {
  const channelId = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const cleanedText = (event.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

  const ctx = tryslackContextFrom({ body, context, event });
  if (!ctx) {
    logger.warn('Dropping an app_mention with no resolvable team/user id.');
    return;
  }

  // Mark the thread engaged BEFORE the bare-mention early return, so the
  // user's next (unmentioned) reply is picked up by the message listener —
  // otherwise the greeting invites a reply the bot then ignores.
  sessionStore.setSession(ctx.teamId, channelId, threadTs, 'engaged');

  if (!cleanedText) {
    await say({
      text: "Hey! I'm the MCPJam agent — tell me what you'd like tested and I'll turn this thread into an eval suite.",
      thread_ts: threadTs,
    });
    return;
  }

  await runAndReply({
    client,
    ctx,
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
