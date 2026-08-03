import { getEvalRun, McpjamApiError, startSuiteRun } from '../../agent/mcpjam-client.js';
import { tenantKey, tryslackContextFrom } from '../../agent/slack-context.js';
import { EventDedupe } from '../../agent/turn-runner.js';
import { claimEvent, completeEvent, hasClaimBackend, releaseEvent } from '../../installations/event-claims.js';

// Status polling: keep the "run started" message honest by editing it with
// the terminal result. Slack-app convention: a kicked-off job's message is
// its status surface — never a dead end.
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_MS = 15 * 60 * 1000;
// Must match the backend's terminal set (`server/routes/v1/evals.ts`).
// `timed_out` is emitted when the runner finalizes a run/iteration timeout;
// omitting it would leave the poller spinning for the full watch window and
// the Slack message stuck on "running…".
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);

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
 * Watch a run until terminal and edit the status message in place.
 * Detached from the button handler; failures degrade to the original
 * "watch it here" message rather than erroring in channel.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ runId: string, url: string, ctx: import('../../agent/slack-context.js').SlackContext, channelId: string, statusTs: string, userId: string, logger: import('@slack/bolt').Logger }} args
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
        return;
      }
    } catch (error) {
      args.logger.warn(`Run status poll failed (will keep trying): ${error}`);
    }
  }
  args.logger.warn(`Run ${args.runId} did not reach a terminal status within the watch window.`);
}

/**
 * Guard against double-clicks and Slack action retries: one run per
 * (suiteId, button message) within the window below — repeat clicks get an
 * ephemeral note instead of a second billed run.
 *
 * The window is explicit and long (a day) rather than the shared 30-minute
 * event default: runs cost quota, and a stray second click hours later in
 * the same working session should still be caught. Past it, a click is
 * treated as a deliberate new decision — which is consistent with the whole
 * design, where the human click IS the approval that spends quota. Bounded
 * by the TTL sweep, so a long-lived bot doesn't grow an entry per click
 * forever.
 *
 * This in-memory guard is now the FAST PATH only. The durable claim below is
 * the real one, and the run's idempotency key is what makes the residual race
 * harmless: even if two clicks both reached `startSuiteRun`, they present the
 * same key and the backend returns the same run.
 */
const RUN_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;

export const runDedupe = new EventDedupe({ ttlMs: RUN_DEDUPE_TTL_MS });

/**
 * The click's stable identity, and the run's idempotency key.
 *
 * Derived from (team, channel, button message, suite) rather than generated
 * per click, so every delivery of the SAME click — a double-click, a Slack
 * action retry, a redelivery after the process died mid-start — produces the
 * same value. That is what lets the backend collapse them onto one run.
 *
 * @param {import('../../agent/slack-context.js').SlackContext} ctx
 * @param {{ channelId: string, messageTs: string, suiteId: string }} args
 */
export function runActionId(ctx, args) {
  return tenantKey(ctx, `run:${args.channelId}:${args.messageTs}:${args.suiteId}`);
}

/**
 * Handle the "Run it" button on a created eval suite. Block actions need
 * an immediate explicit ack (unlike Events API events, which Bolt v5
 * auto-acks before listeners run).
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleRunSuiteButton({ ack, body, client, context, logger, action }) {
  await ack();

  const ctx = tryslackContextFrom({ body, context });
  if (!ctx) {
    logger.warn('Dropping a run-suite click with no resolvable team/user id.');
    return;
  }

  const userId = ctx.slackUserId;
  const channelId = /** @type {string} */ (body.channel?.id);
  const messageTs = /** @type {string} */ (body.message?.ts);
  // The button lives on the bot's reply, which is itself a thread reply.
  // `chat.postMessage` wants the PARENT ts — passing a reply's own ts either
  // errors or starts a stray thread, so prefer the message's `thread_ts`.
  const parentTs = /** @type {string} */ (body.message?.thread_ts ?? body.message?.ts);
  const suiteId = action.value;
  if (!suiteId) return;

  const actionId = runActionId(ctx, { channelId, messageTs, suiteId });

  /** Tell the clicker their click lost the race, without billing a run. */
  const alreadyRunning = () =>
    client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: parentTs,
      text: ':information_source: That run is already going — check the run link above.',
    });

  // Fast path: this process already saw the click.
  if (!runDedupe.claim(actionId)) {
    await alreadyRunning();
    return;
  }

  // Durable transition `proposed → executing`. A double-click races HERE, and
  // exactly one caller wins; the loser is told, not billed. Surviving a
  // restart matters because the expensive half (the run) is what a redelivery
  // would repeat.
  let durable = null;
  if (hasClaimBackend()) {
    try {
      durable = await claimEvent(actionId);
    } catch (error) {
      // Fail closed: a run costs quota, so an unreachable backend must not be
      // read as permission to start one.
      runDedupe.release(actionId);
      logger.error(`Could not claim the run action: ${error}`);
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: parentTs,
        text: ':warning: Could not start the run right now. Try again in a moment.',
      });
      return;
    }
    if (durable.outcome !== 'claimed') {
      await alreadyRunning();
      return;
    }
  }

  /** @type {{ runId: string, url: string }} */
  let run;
  try {
    run = await startSuiteRun(suiteId, ctx, {
      // Same id as the claim. A crash between `executing` and recording the
      // outcome retries into the SAME backend run, never a second one.
      idempotencyKey: actionId,
    });
  } catch (error) {
    // The run provably did not start — release so a retry click can work.
    runDedupe.release(actionId);
    if (durable) await releaseEvent(actionId).catch(() => {});
    logger.error(`Failed to start suite run: ${error}`);
    const friendly =
      error instanceof McpjamApiError
        ? error.friendlyMessage
        : ':warning: Could not start the run. Try again in a moment.';
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: parentTs,
      text: friendly,
    });
    return;
  }

  // Past this point the run EXISTS and is billed. Keep the claim even if
  // announcing it fails — a retry would start (and bill) a second run.
  runDedupe.complete(actionId);
  if (durable) {
    // `executing → succeeded`: the run exists. Recorded before announcing so
    // a failure to post cannot leave the action stuck mid-transition.
    await completeEvent(actionId, { runId: run.runId, url: run.url, suiteId }).catch((error) => {
      logger.warn(`Run ${run.runId} started but recording the action outcome failed: ${error}`);
    });
  }
  try {
    const posted = await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentTs,
      text: `:rocket: Run started by <@${userId}> — running… <${run.url}|watch it here>.`,
    });
    // Detached watcher edits the message with the terminal result.
    if (posted.ts) {
      void watchRunUntilDone(client, {
        runId: run.runId,
        url: run.url,
        ctx,
        channelId,
        statusTs: /** @type {string} */ (posted.ts),
        userId,
        logger,
      });
    }
  } catch (error) {
    logger.error(`Run ${run.runId} started but announcing it failed: ${error}`);
  }
}
