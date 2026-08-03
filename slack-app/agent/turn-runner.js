/**
 * Centralized turn processing for every Slack trigger (DM message, thread
 * reply, @mention). Owns the three correctness concerns the listeners must
 * not re-implement:
 *
 *  1. TTL dedupe on `channel + event ts` — Slack retries events, and a
 *     retry can arrive AFTER the original completed, so an in-flight-only
 *     set is not enough; completed keys are retained for a TTL window.
 *  2. Per-thread serialization — two rapid messages in one thread run one
 *     at a time, so concurrent turns can't both create the same suite.
 *  3. History normalization — the thread is refetched and filtered through
 *     the triggering timestamp (messages newer than the trigger belong to
 *     the NEXT turn), then mapped/truncated to the API's message contract.
 *
 * Note: Bolt v5 auto-acknowledges Events API events before listeners run,
 * so a long-running listener body is fine — no detaching needed here.
 */
import { runAgentTurn } from './mcpjam-client.js';

// API contract limits. These MIRROR the server's schema in
// `mcpjam-inspector/server/routes/v1/agent.ts` — it enforces characters AND
// UTF-8 bytes per message plus an aggregate byte budget, and rejects the
// whole turn with 400 if any is exceeded. Character caps alone are not
// enough: emoji/CJK text is up to 4 bytes per character.
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_MESSAGE_BYTES = 8_192;
const MAX_TOTAL_MESSAGE_BYTES = 98_304; // 96 KB across the whole history

const DEDUPE_TTL_MS = 30 * 60 * 1000;

const utf8Length = (/** @type {string} */ text) => Buffer.byteLength(text, 'utf8');

/**
 * Cap one message against BOTH server limits in a single pass.
 *
 * The two caps are independent: 8,001 ASCII characters break the character
 * limit while staying well under the byte limit, and 4,000 emoji do the
 * reverse. Iteration is by CODE POINT (`for…of`), so a cut never lands
 * inside a surrogate pair — a `String.prototype.slice` on UTF-16 units
 * would happily leave a lone surrogate behind.
 *
 * @param {string} text
 */
export function capMessageContent(text) {
  if (text.length <= MAX_MESSAGE_CHARS && utf8Length(text) <= MAX_MESSAGE_BYTES) return text;
  const suffix = '…';
  const maxUnits = MAX_MESSAGE_CHARS - suffix.length;
  const maxBytes = MAX_MESSAGE_BYTES - utf8Length(suffix);
  let units = 0;
  let bytes = 0;
  let out = '';
  for (const char of text) {
    const nextUnits = units + char.length;
    const nextBytes = bytes + utf8Length(char);
    if (nextUnits > maxUnits || nextBytes > maxBytes) break;
    units = nextUnits;
    bytes = nextBytes;
    out += char;
  }
  return out + suffix;
}

/** @typedef {{ role: 'user' | 'assistant', content: string }} TurnMessage */

/**
 * Dedupe registry: eventKey → completion timestamp (Infinity while
 * in-flight). Swept lazily on insert.
 */
export class EventDedupe {
  /** @param {{ ttlMs?: number, now?: () => number }} [opts] */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? DEDUPE_TTL_MS;
    this.now = opts.now ?? Date.now;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /**
   * Returns true the FIRST time a key is claimed; false for any repeat
   * within the TTL (in-flight or completed).
   * @param {string} key
   */
  claim(key) {
    this.sweep();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Number.POSITIVE_INFINITY);
    return true;
  }

  /**
   * Mark a claimed key completed — it stays deduped for the TTL.
   * @param {string} key
   */
  complete(key) {
    if (this.seen.has(key)) this.seen.set(key, this.now());
  }

  /**
   * Drop a claim entirely so the key can be claimed again immediately.
   * Only for work that provably did NOT happen — never for "unsure".
   * @param {string} key
   */
  release(key) {
    this.seen.delete(key);
  }

  /** Forget every claim (tests). */
  clear() {
    this.seen.clear();
  }

  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, completedAt] of this.seen) {
      if (completedAt !== Number.POSITIVE_INFINITY && completedAt < cutoff) {
        this.seen.delete(key);
      }
    }
  }
}

/**
 * Per-key promise chains: work for the same key runs strictly in order;
 * different keys run concurrently. The chain entry is removed once its
 * last job settles, so the map can't grow unbounded.
 */
export class KeyedQueue {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.chains = new Map();
  }

  /**
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  enqueue(key, job) {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    // Track settlement without swallowing the job's error for the caller.
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, settled);
    settled.then(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key);
    });
    return next;
  }
}

/**
 * Map raw Slack thread messages to the API contract: bot messages become
 * `assistant`, everything else `user`; filtered through the triggering
 * timestamp, truncated per message, and capped to the most recent
 * MAX_MESSAGES.
 *
 * Speaker attribution is deliberately absent: naming humans would need the
 * `users:read` scope, which the manifest does not request. If per-speaker
 * context is ever needed, the scope and the lookup land together.
 *
 * @param {Array<{ ts?: string, text?: string, bot_id?: string, user?: string }>} raw
 * @param {{ botUserId?: string, triggerTs: string }} opts
 * @returns {TurnMessage[]}
 */
export function normalizeThreadMessages(raw, opts) {
  const trigger = Number.parseFloat(opts.triggerTs);
  /** @type {TurnMessage[]} */
  const messages = [];
  for (const message of raw) {
    const text = (message.text || '').trim();
    if (!text) continue;
    const ts = Number.parseFloat(message.ts || '0');
    if (Number.isFinite(trigger) && ts > trigger) continue;
    const isBot = Boolean(message.bot_id) || (opts.botUserId !== undefined && message.user === opts.botUserId);
    messages.push({
      role: isBot ? 'assistant' : 'user',
      content: capMessageContent(text),
    });
  }

  const recent = messages.slice(-MAX_MESSAGES);
  // Aggregate budget: drop the OLDEST messages until the whole history fits.
  // Per-message caps alone can still add up past the server's total.
  let total = recent.reduce((sum, message) => sum + utf8Length(message.content), 0);
  while (recent.length > 1 && total > MAX_TOTAL_MESSAGE_BYTES) {
    total -= utf8Length(/** @type {TurnMessage} */ (recent[0]).content);
    recent.shift();
  }
  return recent;
}

export const dedupe = new EventDedupe();
export const threadQueue = new KeyedQueue();

/**
 * Fetch + normalize the conversation context for a trigger.
 * Channel threads use `conversations.replies`; DM top-level messages use
 * `conversations.history` (a DM has no thread until someone starts one).
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ channelId: string, threadTs: string, triggerTs: string, isThread: boolean, botUserId?: string }} args
 * @returns {Promise<TurnMessage[]>}
 */
export async function fetchThreadContext(client, args) {
  /** @type {Array<Record<string, any>>} */
  let raw = [];
  if (args.isThread) {
    const result = await client.conversations.replies({
      channel: args.channelId,
      ts: args.threadTs,
      limit: 200,
    });
    raw = result.messages ?? [];
  } else {
    const result = await client.conversations.history({
      channel: args.channelId,
      latest: args.triggerTs,
      inclusive: true,
      limit: MAX_MESSAGES,
    });
    raw = (result.messages ?? []).slice().reverse(); // history is newest-first
  }
  return normalizeThreadMessages(raw, {
    botUserId: args.botUserId,
    triggerTs: args.triggerTs,
  });
}

/**
 * Run one full turn for a Slack trigger: dedupe, then — inside the
 * per-conversation queue — gather context, call MCPJam, and post the reply
 * via `onResult`.
 *
 * `onResult` runs INSIDE the queue on purpose. If posting happened after the
 * queue released, a rapid follow-up could start its turn before the previous
 * answer reached the thread: its history would omit that answer (so it may
 * redo the same work, e.g. recreate a suite) and the replies could land out
 * of order.
 *
 * Returns false when the event was a duplicate delivery.
 *
 * @param {{
 *   client: import('@slack/web-api').WebClient,
 *   channelId: string,
 *   threadTs: string,
 *   triggerTs: string,
 *   isThread: boolean,
 *   botUserId?: string,
 *   fallbackText: string,
 *   onStart?: () => Promise<void>,
 *   onResult: (result: import('./mcpjam-client.js').AgentTurnResult) => Promise<void>,
 * }} args
 * @returns {Promise<boolean>}
 */
export async function runTurnForEvent(args) {
  const eventKey = `${args.channelId}:${args.triggerTs}`;
  if (!dedupe.claim(eventKey)) return false;

  // Only after the claim: a duplicate delivery must not raise a "working"
  // status that no reply will ever clear.
  //
  // If it throws, RELEASE the claim: no turn work has happened yet, and an
  // in-flight claim is never swept, so keeping it would silently drop every
  // later redelivery of this event — the user would get no answer at all
  // because a cosmetic status update failed.
  try {
    await args.onStart?.();
  } catch (error) {
    dedupe.release(eventKey);
    throw error;
  }

  // Serialization key. A channel thread keys on its parent ts. A top-level DM
  // has NO thread, so `threadTs` is the message's own ts — keying on that
  // would give every rapid DM its own queue and serialize nothing, which is
  // exactly the case that can create duplicate suites. Key those per channel.
  const queueKey = args.isThread ? `thread:${args.channelId}:${args.threadTs}` : `dm:${args.channelId}`;
  try {
    await threadQueue.enqueue(queueKey, async () => {
      let messages = await fetchThreadContext(args.client, args);
      if (messages.length === 0) {
        // Context fetch can miss (e.g. scopes); fall back to the trigger text.
        messages = [{ role: 'user', content: args.fallbackText }];
      }
      const result = await runAgentTurn(messages);
      await args.onResult(result);
    });
    return true;
  } finally {
    dedupe.complete(eventKey);
  }
}
