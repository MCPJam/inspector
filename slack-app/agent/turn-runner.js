/**
 * Slack's binding to the shared turn runner.
 *
 * The durable-claim state machine (fail-closed on an unreachable claim
 * backend, release-vs-finalize for pre-network failures, per-conversation
 * serialization) now lives in `@mcpjam/surface-core`'s `runTurnForEvent`,
 * verified there by its own tests. What stays HERE is everything that is
 * actually Slack's: fetching Slack history and translating between Slack's
 * `channelId`/`threadTs`/`teamId` vocabulary and the core's generic one.
 */
import { EventDedupe, KeyedQueue, runTurnForEvent as runTurnForEventCore } from '@mcpjam/surface-core';
import { claimEvent, completeEvent, hasClaimBackend, releaseEvent } from '../installations/event-claims.js';
import { runAgentTurn } from './mcpjam-client.js';
import { toSurfaceCtx } from './surface-ctx.js';
import { fetchThreadHistory } from './thread-history.js';

const MAX_MESSAGES = 50;

// Shared across every call in this process, deliberately — dedupe and
// per-conversation serialization only work if every call routes through the
// SAME instances. Kept separate from the core's own shared pair (which
// discord-app defaults to) so a Slack redeploy and a Discord redeploy never
// share dedupe state.
export const dedupe = new EventDedupe();
export const threadQueue = new KeyedQueue();

/**
 * Serialization key. A channel thread keys on its parent ts. A top-level DM
 * has NO thread, so `threadTs` is the message's own ts — keying on that
 * would give every rapid DM its own queue and serialize nothing, which is
 * exactly the case that can create duplicate suites. Key those per channel
 * instead.
 *
 * The core's own default key (`threadId || "root"`) cannot make this
 * distinction for Slack: `threadTs` is always populated, thread or not. This
 * is exactly what `runTurnForEvent`'s `queueKey` override exists for.
 *
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ channelId: string, threadTs: string, isThread: boolean }} args
 */
export function replayQueueKey(ctx, args) {
  return `${ctx.teamId}:${args.isThread ? `thread:${args.channelId}:${args.threadTs}` : `dm:${args.channelId}`}`;
}

/**
 * Run one full turn for a Slack trigger: claim it, then — inside the
 * per-conversation queue — gather context, call MCPJam, and post the reply
 * via `onResult`.
 *
 * @param {{
 *   client: import('@slack/web-api').WebClient,
 *   ctx: import('./slack-context.js').SlackContext,
 *   channelId: string,
 *   threadTs: string,
 *   triggerTs: string,
 *   eventId?: string,
 *   isThread: boolean,
 *   botUserId?: string,
 *   fallbackText: string,
 *   onStart?: () => Promise<void>,
 *   onResult: (result: import('./mcpjam-client.js').AgentTurnResult) => Promise<void>,
 *   onReplay?: (envelope: import('./mcpjam-client.js').AgentTurnResult) => Promise<void>,
 * }} args
 * @returns {Promise<boolean>}
 */
export function runTurnForEvent(args) {
  return runTurnForEventCore({
    dedupe,
    queue: threadQueue,
    // Only for the core's OWN internal key derivation (eventKey/dedupeKey);
    // `apiClient.runAgentTurn` below closes over the ORIGINAL Slack-shaped
    // `args.ctx` instead of whatever this becomes, since Slack's own
    // `runAgentTurn` needs `teamId`/`slackUserId`/`mode`/`projectId` — a
    // vocabulary the core's generic ctx does not carry.
    ctx: toSurfaceCtx(args.ctx),
    conversationId: args.channelId,
    threadId: args.threadTs,
    // The KEY, not the content filter — a bare string, matching the fork's
    // own `eventKey`/`dedupeKey` derivation exactly so an in-flight claim
    // keeps matching across this migration.
    triggerMessageId: args.triggerTs,
    triggerTimestampMs: Number.parseFloat(args.triggerTs) * 1000,
    eventId: args.eventId,
    botUserId: args.botUserId,
    fallbackText: args.fallbackText,
    queueKey: replayQueueKey(args.ctx, args),
    fetchHistory: () =>
      fetchThreadHistory(args.client, {
        channelId: args.channelId,
        threadTs: args.threadTs,
        triggerTs: args.triggerTs,
        isThread: args.isThread,
        botUserId: args.botUserId,
        limit: MAX_MESSAGES,
      }),
    apiClient: {
      /** @param {any[]} history @param {any} _coreCtx @param {{idempotencyKey?: string}} opts */
      runAgentTurn: (history, _coreCtx, opts) =>
        runAgentTurn(history, args.ctx, {
          idempotencyKey: opts.idempotencyKey,
          channelId: args.channelId,
        }),
    },
    eventClaims: { hasClaimBackend, claimEvent, completeEvent, releaseEvent },
    onStart: args.onStart,
    onResult: args.onResult,
    onReplay: args.onReplay,
  });
}
