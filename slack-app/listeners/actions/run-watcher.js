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
import { getEvalRun } from '../../agent/mcpjam-client.js';

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
 * @param {{ status: string, result: string | null, summary?: { passed?: number, total?: number } }} run
 * @param {string} url
 * @param {string} userId
 */
export function formatRunOutcome(run, url, userId) {
  const counts = run.summary?.total !== undefined ? ` (${run.summary.passed ?? 0}/${run.summary.total} passed)` : '';
  if (run.status === 'completed' && run.result === 'passed') {
    return `:large_green_circle: Run passed${counts} — started by <@${userId}>, <${url}|see the details>.`;
  }
  if (run.status === 'cancelled') {
    return `:heavy_minus_sign: Run cancelled — started by <@${userId}>, <${url}|details>.`;
  }
  if (run.status === 'timed_out') {
    return `:hourglass: Run timed out${counts} — started by <@${userId}>, <${url}|details>.`;
  }
  return `:red_circle: Run ${run.result === 'failed' ? 'failed' : run.status}${counts} — started by <@${userId}>, <${url}|see what broke>.`;
}

/**
 * Whether a terminal run is the red-circle case — the one whose thread said
 * "see what broke". Matches `formatRunOutcome`'s failure branch so evidence
 * and outcome copy can never disagree: posting screenshots under a green
 * "Run passed" is noise, and a *passing* run's screenshots under a red
 * verdict actively misleads the approver about what broke.
 *
 * @param {{ status: string, result: string | null }} run
 */
export function isFailedOutcome(run) {
  return run?.status === 'failed' || (run?.status === 'completed' && run?.result === 'failed');
}

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
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    // unref: a detached watcher must never hold the process open.
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      timer.unref?.();
    });
    try {
      const run = await getEvalRun(args.runId, args.ctx);
      if (TERMINAL_STATUSES.has(run.status)) {
        await client.chat.update({
          channel: args.channelId,
          ts: args.statusTs,
          text: formatRunOutcome(run, args.url, args.userId),
        });
        if (args.onTerminal) {
          // Anything hung off completion (evidence, notifications) is strictly
          // additive: it must never turn a reported outcome into an unhandled
          // rejection, and never stop the message above from being correct.
          await args.onTerminal(run).catch((error) => {
            args.logger.warn(`Post-run follow-up failed for ${args.runId}: ${error}`);
          });
        }
        return;
      }
    } catch (error) {
      args.logger.warn(`Run status poll failed (will keep trying): ${error}`);
    }
  }
  args.logger.warn(`Run ${args.runId} did not reach a terminal status within the watch window.`);
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
