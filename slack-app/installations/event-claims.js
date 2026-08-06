/**
 * Slack's binding to the shared durable-claim client.
 *
 * The in-memory `EventDedupe` is a fast path, not a guarantee: it dies with
 * the process, so a Slack redelivery after a restart runs the turn again. And
 * even a perfect dedupe cannot help with the case where the turn finished,
 * persisted an eval suite, and then lost its reply — from which the only
 * choices are dropping the answer or re-running the work.
 *
 * A durable claim solves both by carrying the ANSWER: the claim is taken
 * before processing, and the reply envelope is stored on completion, so a
 * late redelivery replays the reply instead of re-running the turn.
 *
 * FAIL-CLOSED, enforced in the core client: every helper throws on a backend
 * failure rather than returning a "go ahead" default. A claim that silently
 * degrades to "you own it" turns one Slack event into two billed turns.
 *
 * THE KEY FORMAT IS PINNED. Slack has been claiming on a bare
 * `${teamId}:${event_id}` since before there was a second surface, and the
 * same string travels to the server as the turn's idempotency key. Adopting
 * the core's default `slack:`-prefixed namespace would re-key every claim in
 * flight across the deploy AND change the per-write keys the server derives —
 * so this surface keeps its own format, deliberately.
 */
import { createEventClaims } from '@mcpjam/surface-core';
import { backend } from './backend-client.js';

const claims = createEventClaims({
  backend,
  surfaceKind: 'slack',
  formatKey: (dedupeKey) => dedupeKey,
  hasBackend: () => Boolean(process.env.MCPJAM_CONVEX_HTTP_URL && process.env.SLACK_SERVICE_TOKEN),
});

/**
 * @typedef {Object} ClaimResult
 * @property {'claimed' | 'inflight' | 'completed'} outcome
 * @property {any} resultEnvelope  Stored reply, present only for 'completed'.
 */

/** True when durable claims are available; false in local socket-mode dev. */
export const hasClaimBackend = claims.hasClaimBackend;

/**
 * Take the claim for `dedupeKey`.
 *
 * @type {(dedupeKey: string, opts?: { fetchImpl?: typeof fetch }) => Promise<ClaimResult>}
 * @param dedupeKey `${teamId}:${event_id}` — team-prefixed because Slack event
 *   ids are only unique within a workspace.
 */
export const claimEvent = claims.claimEvent;

/** Record the turn's outcome so a redelivery replays it instead of re-running. */
export const completeEvent = claims.completeEvent;

/**
 * Drop a claim so the event can be processed again immediately.
 *
 * ONLY for work that provably did NOT happen. An "unsure" release is how a
 * paid mutation runs twice; for those, leave the claim and let its TTL expire.
 */
export const releaseEvent = claims.releaseEvent;
