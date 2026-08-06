/**
 * DEPRECATION SHIM.
 *
 * The "Run it" button that used to sit on every created-suite block is retired:
 * new replies render running a suite as an ordinary PROPOSAL, which goes
 * through the persisted-contract / durable-claim / clicker-is-authorizer path
 * that everything else that spends already uses.
 *
 * This handler stays registered because Slack messages are permanent. Buttons
 * on messages posted before the switch are still sitting in channels and still
 * clickable, and a click that silently does nothing is worse than one that
 * works. It goes — along with the `POST /eval-runs` entries in the inspector's
 * `SLACK_ALLOWED_PATHS` — in a later cleanup, once those messages have aged out
 * of anyone's scrollback.
 *
 * Do not add features here. New behaviour belongs on the proposal path.
 */
import { McpjamApiError, startSuiteRun } from '../../agent/mcpjam-client.js';
import { friendlyMessage as slackFriendlyMessage } from '../../render/slack.js';
import { tenantKey, tryslackContextFrom } from '../../agent/slack-context.js';
import { EventDedupe } from '../../agent/turn-runner.js';
import { resolveTurnTarget } from '../../agent/turn-target.js';
import { claimEvent, completeEvent, hasClaimBackend, releaseEvent } from '../../installations/event-claims.js';
import { watchRunUntilDone } from './run-watcher.js';

// The poll loop moved to `run-watcher.js` so the approval path can share it.
// Re-exported here so existing importers keep working while the shim lives.
export { formatRunOutcome, watchRunUntilDone } from './run-watcher.js';

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

  // The click runs as the CLICKER, in the thread's project — the same
  // resolution the turn used. Without this the credential seam has no mode
  // and refuses outright, and a legacy-workspace clicker who HAS linked would
  // otherwise fall back to the shared key instead of their own project.
  let target;
  try {
    target = await resolveTurnTarget(ctx, { channelId, threadTs: parentTs });
  } catch (error) {
    logger.error(`Could not resolve the run target: ${error}`);
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: parentTs,
      text: ':warning: Could not start the run right now. Try again in a moment.',
    });
    return;
  }
  if (target.mode === 'unlinked' || target.mode === 'needs_project') {
    // Reauthorizing the CLICKER is the point: the person who created the
    // suite is not the person spending quota here.
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: parentTs,
      text:
        target.mode === 'unlinked'
          ? ':link: Connect your MCPJam account (in my Home tab) before starting a run.'
          : ':open_file_folder: Pick a default MCPJam project (in my Home tab) before starting a run.',
    });
    return;
  }
  const runCtx = { ...ctx, mode: target.mode, projectId: target.projectId };

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
    if (durable.outcome === 'completed') {
      // The run already exists AND we stored its link. Handing that link over
      // beats "check the run link above": the winning click may have been in a
      // different message, or made by someone else entirely, so "above" can
      // point at nothing this person can see.
      const storedUrl = typeof durable.resultEnvelope?.url === 'string' ? durable.resultEnvelope.url : null;
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: parentTs,
        text: storedUrl
          ? `:information_source: That suite is already running — <${storedUrl}|watch it here>.`
          : ':information_source: That run is already going — check the run link above.',
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
    run = await startSuiteRun(suiteId, runCtx, {
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
        ? slackFriendlyMessage(error)
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
        ctx: runCtx,
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
