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

// API contract limits (mirror the server's schema).
const MAX_MESSAGES = 50;
const MAX_MESSAGE_CHARS = 8_000;

const DEDUPE_TTL_MS = 30 * 60 * 1000;

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
      content: text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text,
    });
  }
  return messages.slice(-MAX_MESSAGES);
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
 * Run one full turn for a Slack trigger: dedupe, serialize per thread,
 * gather context, call MCPJam, and hand the result back to the listener
 * for posting. Returns null when the event was a duplicate.
 *
 * @param {{
 *   client: import('@slack/web-api').WebClient,
 *   channelId: string,
 *   threadTs: string,
 *   triggerTs: string,
 *   isThread: boolean,
 *   botUserId?: string,
 *   fallbackText: string,
 * }} args
 * @returns {Promise<import('./mcpjam-client.js').AgentTurnResult | null>}
 */
export async function runTurnForEvent(args) {
  const eventKey = `${args.channelId}:${args.triggerTs}`;
  if (!dedupe.claim(eventKey)) return null;

  const threadKey = `${args.channelId}:${args.threadTs}`;
  try {
    return await threadQueue.enqueue(threadKey, async () => {
      let messages = await fetchThreadContext(args.client, args);
      if (messages.length === 0) {
        // Context fetch can miss (e.g. scopes); fall back to the trigger text.
        messages = [{ role: 'user', content: args.fallbackText }];
      }
      return runAgentTurn(messages);
    });
  } finally {
    dedupe.complete(eventKey);
  }
}
