import { getEvalRun, McpjamApiError, startSuiteRun } from '../../agent/mcpjam-client.js';

// Status polling: keep the "run started" message honest by editing it with
// the terminal result. Slack-app convention: a kicked-off job's message is
// its status surface — never a dead end.
const POLL_INTERVAL_MS = 10_000;
const POLL_MAX_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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
  return `:red_circle: Run ${run.result === 'failed' ? 'failed' : run.status}${counts} — started by <@${userId}>, <${url}|see what broke>.`;
}

/**
 * Watch a run until terminal and edit the status message in place.
 * Detached from the button handler; failures degrade to the original
 * "watch it here" message rather than erroring in channel.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{ runId: string, url: string, channelId: string, statusTs: string, userId: string, logger: import('@slack/bolt').Logger }} args
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
      const run = await getEvalRun(args.runId);
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
 * Guard against double-clicks / Slack action retries: one run per
 * (suiteId, message) — repeat clicks get an ephemeral note instead of a
 * second run. Completed keys are retained (a suite run started from this
 * message stays started; a NEW run should come from a fresh agent reply
 * or the app UI).
 * @type {Set<string>}
 */
export const startedRunKeys = new Set();

/**
 * Handle the "Run it" button on a created eval suite. Block actions need
 * an immediate explicit ack (unlike Events API events, which Bolt v5
 * auto-acks before listeners run).
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleRunSuiteButton({ ack, body, client, context, logger, action }) {
  await ack();

  const userId = /** @type {string} */ (context.userId);
  const channelId = /** @type {string} */ (body.channel?.id);
  const messageTs = /** @type {string} */ (body.message?.ts);
  const suiteId = action.value;
  if (!suiteId) return;

  const runKey = `${suiteId}:${messageTs}`;
  if (startedRunKeys.has(runKey)) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: messageTs,
      text: ':information_source: That run is already going — check the run link above.',
    });
    return;
  }
  startedRunKeys.add(runKey);

  try {
    const run = await startSuiteRun(suiteId);
    const posted = await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: `:rocket: Run started by <@${userId}> — running… <${run.url}|watch it here>.`,
    });
    // Detached watcher edits the message with the terminal result.
    if (posted.ts) {
      void watchRunUntilDone(client, {
        runId: run.runId,
        url: run.url,
        channelId,
        statusTs: /** @type {string} */ (posted.ts),
        userId,
        logger,
      });
    }
  } catch (error) {
    // The run never started; allow a retry click.
    startedRunKeys.delete(runKey);
    logger.error(`Failed to start suite run: ${error}`);
    const friendly =
      error instanceof McpjamApiError
        ? error.friendlyMessage
        : ':warning: Could not start the run. Try again in a moment.';
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: messageTs,
      text: friendly,
    });
  }
}
