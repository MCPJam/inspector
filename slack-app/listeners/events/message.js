import { tryslackContextFrom } from '../../agent/slack-context.js';
import { fetchThreadBinding } from '../../agent/turn-target.js';
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
export async function handleMessage({ body, client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  // A message with no resolvable tenant/actor is unroutable: we would not
  // know whose credentials to act with. Drop it — there is nowhere safe to
  // post an error, and answering under a guessed tenant is exactly the
  // failure this threading exists to prevent.
  const ctx = tryslackContextFrom({ body, context, event });
  if (!ctx) {
    logger.warn('Dropping a message event with no resolvable team/user id.');
    return;
  }

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged.
    //
    // The in-memory store is a CACHE over the durable thread binding, not the
    // source of truth: it dies with the process, so before this the bot went
    // deaf in every engaged thread after a restart and the user had to
    // re-mention it with no indication why. The binding is authoritative, so
    // a miss falls through to it and re-warms the cache.
    const threadTs = /** @type {string} */ (event.thread_ts);
    if (sessionStore.getSession(ctx.teamId, event.channel, threadTs) === null) {
      const binding = await fetchThreadBinding(ctx.teamId, event.channel, threadTs).catch((error) => {
        // Unknown, not "not engaged". Dropping is the safe half of the
        // decision: Slack will not retry a message we chose to ignore, but
        // answering a thread we were never invited to is worse than a missed
        // reply the user can re-trigger with a mention.
        logger.warn(`Could not check the thread binding for ${threadTs}: ${error}`);
        return null;
      });
      if (!binding) return;
      sessionStore.setSession(ctx.teamId, event.channel, threadTs, 'engaged');
    }
  } else {
    // Top-level channel messages are handled by app_mentioned
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
    channelId: event.channel,
    threadTs: event.thread_ts || event.ts,
    triggerTs: event.ts,
    // Slack's event_id identifies the DELIVERY CHAIN: every redelivery of
    // this event carries it unchanged, which is what the durable claim keys on.
    ...(typeof body?.event_id === 'string' ? { eventId: body.event_id } : {}),
    // A DM top-level message has no thread yet; channel replies do.
    isThread: isThreadReply,
    fallbackText: event.text || '',
  });
}
