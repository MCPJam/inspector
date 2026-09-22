/**
 * Watching a JOURNEY (Swarms) run to its end in Slack, and saying what
 * happened.
 *
 * A sibling of `run-watcher.js`, not a mode on it — the core keeps the two
 * watchers separate (`@mcpjam/surface-core`'s `journey-run-watcher.js` header
 * has the full argument) and this adapter keeps the same boundary: everything
 * in here is Slack copy and `chat.*` calls, while "when is it over and what
 * does over mean" belongs to the core.
 *
 * SLACK-APP CONVENTION, same as eval runs: a kicked-off run's message IS its
 * status surface. The message that says "running…" is the same message that
 * later says how it went — including after the watch window expires, when it
 * must say "still running, check the app" rather than staying on "running…"
 * forever and reading as a hang.
 */
import {
  collectJourneyRunEvidence,
  formatJourneyRunEvidenceLines,
  journeyOutcomeWantsEvidence,
  watchJourneyRunUntilDone,
} from '@mcpjam/surface-core';
import { getJourneyRun, getJourneyRunScorecard, listJourneyRunSessions } from '../../agent/mcpjam-client.js';

const POLL_INTERVAL_MS = 15_000;
// An hour, not the eval watcher's fifteen minutes: a fan-out across four
// environments at ten sessions each is forty conversations, and fifteen
// minutes times out on the ordinary case.
const POLL_MAX_MS = 60 * 60 * 1000;
const EVIDENCE_SESSION_LIMIT = 5;

/**
 * The Slack line for a settled journey run.
 *
 * Keyed on the OUTCOME KIND the core derived, never on `status`: a stopped
 * run arrives as `status: "failed"` with `canceled: true`, and telling the
 * person who pressed Stop that their run failed is the kind of wrong that
 * sends them hunting for a bug.
 *
 * @param {Record<string, any>} run
 * @param {{kind: string, succeeded: number, failed: number, rateLimited: number, total: number}} outcome
 * @param {string} url
 * @param {string} userId
 */
export function formatJourneyRunOutcome(run, outcome, url, userId) {
  const counts = outcome.total > 0 ? ` (${outcome.succeeded}/${outcome.total} sessions reached their goal)` : '';
  const who = ` — approved by <@${userId}>`;
  switch (outcome.kind) {
    case 'passed':
      return `:large_green_circle: Swarm run passed${counts}${who}, <${url}|see the sessions>.`;
    case 'partial':
      return `:large_yellow_circle: Swarm run finished mixed${counts}${who}, <${url}|see what happened>.`;
    case 'failed':
      return `:red_circle: Swarm run failed${counts}${who}, <${url}|see what broke>.`;
    case 'rate_limited':
      return `:red_circle: Swarm run stopped early — model capacity ran out${counts}${who}, <${url}|details>.`;
    case 'stopped':
      return `:heavy_minus_sign: Swarm run stopped by request${counts}${who}, <${url}|details>.`;
    case 'stalled':
      return `:warning: Swarm runner went silent — results are incomplete${counts}${who}, <${url}|details>.`;
    default:
      return `:white_circle: Swarm run settled${counts}${who}, <${url}|details>.`;
  }
}

/**
 * Post the scorecard-and-sessions evidence under the outcome message.
 *
 * Text, not screenshots — a journey run has no per-step trace to attach; its
 * evidence is which rubric criteria failed and which personas did not reach
 * the goal. Posted ONLY for outcomes whose message says something broke
 * (`journeyOutcomeWantsEvidence`): counts under a green verdict are noise.
 *
 * Strictly additive, mirroring eval evidence: by the time this runs the
 * outcome message is already correct, so every failure in here is logged and
 * swallowed rather than allowed to make the run look unreported.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{runId: string, ctx: any, channelId: string, threadTs: string, logger: import('@slack/bolt').Logger}} args
 */
export async function postJourneyRunEvidence(client, args) {
  try {
    const evidence = await collectJourneyRunEvidence({
      apiClient: { getJourneyRunScorecard, listJourneyRunSessions },
      ctx: args.ctx,
      runId: args.runId,
      limit: EVIDENCE_SESSION_LIMIT,
      logger: args.logger,
    });
    const lines = formatJourneyRunEvidenceLines(evidence, {
      maxSessions: EVIDENCE_SESSION_LIMIT,
    });
    if (lines.length === 0) return;
    await client.chat.postMessage({
      channel: args.channelId,
      thread_ts: args.threadTs,
      text: lines.join('\n'),
    });
  } catch (error) {
    args.logger.warn(`Journey run ${args.runId} evidence failed: ${error}`);
  }
}

/**
 * Post the "swarm running…" message and hand it to a detached watcher.
 *
 * One operation, like the eval twin: a run announced without a watcher leaves
 * a message that says "running…" forever, and a watcher without a message has
 * nothing to edit.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{
 *   runId: string,
 *   url: string,
 *   ctx: import('../../agent/slack-context.js').SlackContext,
 *   channelId: string,
 *   threadTs: string,
 *   userId: string,
 *   logger: import('@slack/bolt').Logger,
 *   text?: string,
 * }} args
 */
export async function announceAndWatchJourneyRun(client, args) {
  const posted = await client.chat.postMessage({
    channel: args.channelId,
    thread_ts: args.threadTs,
    text: args.text ?? `:rocket: Approved by <@${args.userId}> — swarm running… <${args.url}|watch it here>.`,
  });
  if (!posted.ts) return;
  const statusTs = /** @type {string} */ (posted.ts);
  void (async () => {
    const run = await watchJourneyRunUntilDone({
      apiClient: { getJourneyRun },
      ctx: args.ctx,
      runId: args.runId,
      url: args.url,
      actorId: args.userId,
      pollIntervalMs: POLL_INTERVAL_MS,
      maxMs: POLL_MAX_MS,
      statusHandle: { id: statusTs, channelId: args.channelId },
      formatOutcome: (run, outcome, url, actorId) => formatJourneyRunOutcome(run, outcome, url, actorId),
      logger: args.logger,
      onTerminal: async (_run, outcome) => {
        if (!journeyOutcomeWantsEvidence(outcome)) return;
        await postJourneyRunEvidence(client, {
          runId: args.runId,
          ctx: args.ctx,
          channelId: args.channelId,
          threadTs: args.threadTs,
          logger: args.logger,
        });
      },
      delivery: {
        edit: (/** @type {any} */ handle, /** @type {any} */ content) =>
          client.chat.update({
            channel: handle.channelId,
            ts: handle.id,
            text: content,
          }),
      },
    });
    // The core returns null when the watch WINDOW expired, not when the run
    // did — nothing failed, we stopped watching. The message must say so:
    // left on "running…" it reads as a hang, and edited to a verdict it
    // would be a lie about a run that is still going.
    if (run === null) {
      try {
        await client.chat.update({
          channel: args.channelId,
          ts: statusTs,
          text: `:hourglass_flowing_sand: Swarm run is still going after an hour — <${args.url}|follow the rest in the app>.`,
        });
      } catch (error) {
        args.logger.warn(`Journey run ${args.runId} still-running edit failed: ${error}`);
      }
    }
  })();
}
