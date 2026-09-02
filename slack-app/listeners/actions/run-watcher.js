/**
 * Watching a run to its end, and saying what happened.
 *
 * Extracted from the legacy Run-it button handler because the APPROVAL path
 * needs it too: a run started by approving a proposal deserves the same live
 * status message as one started by the old button, and duplicating the poll
 * loop is how the two would drift into telling users different things about
 * identical runs.
 *
 * Nothing in here is Slack-specific except the `chat.update` call itself, which
 * is the seam a second wrapper would replace. Keeping it free of Slack imports
 * beyond the client is deliberate — this file is one of the four the Discord
 * work will lift into a shared package.
 *
 * SLACK-APP CONVENTION: a kicked-off job's message IS its status surface. It is
 * never a dead end — the message that says "running…" is the same message that
 * later says how it went.
 */
import { formatFirstBreak, watchRunUntilDone as watchCoreRunUntilDone } from '@mcpjam/surface-core';
import { getEvalRun, getEvalRunDecisionSummary } from '../../agent/mcpjam-client.js';

const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_MS = 15 * 60 * 1000;

/**
 * Must match the backend's terminal set (`server/routes/v1/evals.ts`).
 * `timed_out` is emitted when the runner finalizes a run/iteration timeout;
 * omitting it would leave the poller spinning for the full watch window and the
 * Slack message stuck on "running…".
 */
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

/**
 * Slack's mrkdwn-and-emoji rendering of a terminal run.
 *
 * A DUPLICATE OF `surface-core`'s `formatRunOutcome` on purpose — the emoji
 * tiers are what Slack readers scan, and the core returns structured parts
 * rather than a string. What is NOT duplicated is the chain derivation:
 * `formatFirstBreak` is imported, so the six stages, seven categories and
 * twenty-nine reasons have exactly one spelling across both surfaces.
 *
 * @param {{ status: string, result: string | null, summary?: { passed?: number, total?: number } }} run
 * @param {string} url
 * @param {string} userId
 * @param {any} [decisionSummary] the run's `decision-summary`, or null. Absent
 *   on a pass, on an older deployment, and whenever the read failed — the line
 *   then reads exactly as it did before the chain existed.
 */
export function formatRunOutcome(run, url, userId, decisionSummary) {
  const counts = run.summary?.total !== undefined ? ` (${run.summary.passed ?? 0}/${run.summary.total} passed)` : '';
  if (run.status === 'completed' && run.result === 'passed') {
    return `:large_green_circle: Run passed${counts} — started by <@${userId}>, <${url}|see the details>.`;
  }
  // The chain sentence goes on its OWN line under the verdict, for everything
  // that is not a clean pass. Empty whenever the summary establishes no break.
  const firstBreak = formatFirstBreak(decisionSummary);
  const chain = firstBreak ? `\n${firstBreak}` : '';
  if (run.status === 'cancelled') {
    return `:heavy_minus_sign: Run cancelled — started by <@${userId}>, <${url}|details>.${chain}`;
  }
  if (run.status === 'timed_out') {
    return `:hourglass: Run timed out${counts} — started by <@${userId}>, <${url}|details>.${chain}`;
  }
  // A NO-VERDICT IS NOT A FAILURE. `inconclusive` is a decision the validity
  // phase reached — the run did not measure the server well enough to judge it
  // — and the red branch below rendered it as ":red_circle: Run inconclusive …
  // see what broke", sending a reader to hunt for a defect nothing found.
  // Both conjuncts, mirroring the pass branch: the watcher only calls this on a
  // terminal status, so the status half is defensive symmetry.
  if (run.status === 'completed' && run.result === 'inconclusive') {
    return `:warning: Run inconclusive${counts} — it did not measure the server well enough to judge it — started by <@${userId}>, <${url}|see what it measured>.${chain}`;
  }
  return `:red_circle: Run ${run.result === 'failed' ? 'failed' : run.status}${counts} — started by <@${userId}>, <${url}|see what broke>.${chain}`;
}

/**
 * Whether a terminal run is the red-circle case — the one whose thread said
 * "see what broke". Matches `formatRunOutcome`'s failure branch so evidence
 * and outcome copy can never disagree.
 *
 * NOW SHARED with the Discord surface, which was checking `status` alone and
 * so treated a run that COMPLETED with `result: 'failed'` as a success. Both
 * surfaces re-export the one predicate rather than each keeping their own,
 * because a divergence here shows up as evidence attached to the wrong verdict
 * rather than as an error. Re-exported (not re-implemented) so this name keeps
 * resolving for every existing importer and test.
 */
export { isFailedOutcome } from '@mcpjam/surface-core';

/**
 * Watch a run until terminal and edit the status message in place.
 *
 * Detached from whichever handler started it; failures degrade to leaving the
 * original "watch it here" message alone rather than erroring in channel. The
 * user still has the link, which is the part that matters.
 *
 * @param {import('@slack/web-api').WebClient} client
 * @param {{
 *   runId: string,
 *   url: string,
 *   ctx: import('../../agent/slack-context.js').SlackContext,
 *   channelId: string,
 *   statusTs: string,
 *   userId: string,
 *   logger: import('@slack/bolt').Logger,
 *   onTerminal?: (run: { status: string, result: string | null }) => Promise<void>,
 * }} args
 */
export async function watchRunUntilDone(client, args) {
  return watchCoreRunUntilDone({
    apiClient: { getEvalRun, getEvalRunDecisionSummary },
    ctx: args.ctx,
    runId: args.runId,
    url: args.url,
    actorId: args.userId,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxMs: POLL_MAX_MS,
    statusHandle: { id: args.statusTs, channelId: args.channelId },
    formatOutcome: (run, url, actorId, decisionSummary) => formatRunOutcome(run, url, actorId, decisionSummary),
    logger: args.logger,
    onTerminal: args.onTerminal,
    delivery: {
      edit: (/** @type {any} */ handle, /** @type {any} */ content) =>
        client.chat.update({
          channel: handle.channelId,
          ts: handle.id,
          text: content,
        }),
    },
  });
}

/**
 * Post the "started" message and hand it to a detached watcher.
 *
 * The two are one operation: a run announced without a watcher leaves a message
 * that says "running…" forever, and a watcher without a message has nothing to
 * edit. Callers that got this wrong are why it lives here.
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
 *   onTerminal?: (run: { status: string, result: string | null }) => Promise<void>,
 * }} args
 */
export async function announceAndWatchRun(client, args) {
  const posted = await client.chat.postMessage({
    channel: args.channelId,
    thread_ts: args.threadTs,
    text: args.text ?? `:rocket: Run started by <@${args.userId}> — running… <${args.url}|watch it here>.`,
  });
  if (!posted.ts) return;
  void watchRunUntilDone(client, {
    runId: args.runId,
    url: args.url,
    ctx: args.ctx,
    channelId: args.channelId,
    statusTs: /** @type {string} */ (posted.ts),
    userId: args.userId,
    logger: args.logger,
    ...(args.onTerminal ? { onTerminal: args.onTerminal } : {}),
  });
}
