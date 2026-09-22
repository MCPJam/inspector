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
 * Short-lived NEGATIVE cache for "this thread has no binding".
 *
 * The positive answer is already cached in `sessionStore`, so without this the
 * only threads that pay a backend round trip are the ones we do not serve —
 * every reply in every busy thread of every channel the bot happens to be in.
 * That is unbounded work driven by strangers' conversations.
 *
 * The TTL is short because the miss is RECOVERABLE and the staleness window is
 * the cost of being wrong: a thread that gets bound during it stays deaf until
 * the entry expires, and the user's obvious next move — mentioning the bot —
 * goes to `app_mentioned`, which does not consult this cache at all.
 */
const NEGATIVE_BINDING_TTL_MS = 60_000;
const NEGATIVE_BINDING_MAX = 10_000;
/** @type {Map<string, number>} */
const unboundThreads = new Map();

/** @param {string} key */
function recentlyUnbound(key) {
  const expiresAt = unboundThreads.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  unboundThreads.delete(key);
  return false;
}

/** @param {string} key */
function rememberUnbound(key) {
  if (unboundThreads.size >= NEGATIVE_BINDING_MAX) {
    // Sweep expired entries first; only if that frees nothing does the oldest
    // insertion go. A cache that can grow without bound is a memory leak with
    // a friendlier name.
    const now = Date.now();
    for (const [candidate, expiresAt] of unboundThreads) {
      if (expiresAt <= now) unboundThreads.delete(candidate);
    }
    if (unboundThreads.size >= NEGATIVE_BINDING_MAX) {
      const oldest = unboundThreads.keys().next();
      if (!oldest.done) unboundThreads.delete(oldest.value);
    }
  }
  unboundThreads.set(key, Date.now() + NEGATIVE_BINDING_TTL_MS);
}

/**
 * Forget that a thread looked unbound.
 *
 * Called the moment a thread becomes engaged. Without it, a thread bound while
 * a negative entry is live stays deaf for the rest of that entry's minute — the
 * in-memory session hides the problem only until it is evicted, and then the
 * stale miss suppresses replies to a thread the bot is genuinely part of.
 * @param {string} teamId
 * @param {string} channelId
 * @param {string} threadTs
 */
export function forgetUnboundThread(teamId, channelId, threadTs) {
  unboundThreads.delete(`${teamId}:${channelId}:${threadTs}`);
}

/** Test-only. */
export function resetUnboundThreadCache() {
  unboundThreads.clear();
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
    if (sessionStore.get(ctx.teamId, event.channel, threadTs) === null) {
      const negativeKey = `${ctx.teamId}:${event.channel}:${threadTs}`;
      if (recentlyUnbound(negativeKey)) return;
      const binding = await fetchThreadBinding(ctx.teamId, event.channel, threadTs).catch((error) => {
        // Unknown, not "not engaged". Dropping is the safe half of the
        // decision: Slack will not retry a message we chose to ignore, but
        // answering a thread we were never invited to is worse than a missed
        // reply the user can re-trigger with a mention.
        logger.warn(`Could not check the thread binding for ${threadTs}: ${error}`);
        // Deliberately NOT cached: "we could not ask" is not "the answer is
        // no", and caching it would extend one backend blip into a minute of
        // silence in a thread that is genuinely engaged.
        return { unavailable: true };
      });
      if (!binding) {
        rememberUnbound(negativeKey);
        return;
      }
      if (/** @type {any} */ (binding).unavailable) return;
      sessionStore.set(ctx.teamId, event.channel, threadTs, 'engaged');
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
