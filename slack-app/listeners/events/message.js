import { sessionStore } from '../../thread-context/index.js';
import { runAndReply } from './run-and-reply.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * Handle messages sent to the agent via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged
    const session = sessionStore.getSession(event.channel, /** @type {string} */ (event.thread_ts));
    if (session === null) return;
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  await runAndReply({
    client,
    context,
    logger,
    say,
    sayStream,
    setStatus,
    channelId: event.channel,
    threadTs: event.thread_ts || event.ts,
    triggerTs: event.ts,
    // A DM top-level message has no thread yet; channel replies do.
    isThread: isThreadReply,
    fallbackText: event.text || '',
  });
}
