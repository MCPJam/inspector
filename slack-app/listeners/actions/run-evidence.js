/**
 * Post a finished run's screenshots into its thread.
 *
 * Which pictures to show, and how to download them safely, is
 * `@mcpjam/surface-core`'s problem — the failure-first selection, the
 * across-the-whole-run dedupe, and the https-only bounded fetch are the same
 * on every surface. What is Slack's is the last step: `files.uploadV2` into a
 * thread, with a caption per image.
 *
 * Called from the run watcher's completion hook, AFTER the outcome message has
 * been written. Resolves rather than rejects on every failure path: the
 * outcome is already correct and posted, and this is the extra.
 */
import { fetchRunEvidence, MAX_SCREENSHOTS } from '@mcpjam/surface-core';

import { getEvalRunSteps, listEvalRunIterations } from '../../agent/mcpjam-client.js';

/**
 * @param {import('@slack/web-api').WebClient} client
 * @param {{
 *   runId: string,
 *   ctx: import('../../agent/slack-context.js').SlackContext,
 *   channelId: string,
 *   threadTs: string,
 *   logger: import('@slack/bolt').Logger,
 *   fetchImpl?: typeof fetch,
 * }} args
 * @returns {Promise<number>} how many images were uploaded
 */
export async function postRunEvidence(client, args) {
  const evidence = await fetchRunEvidence({
    apiClient: { listEvalRunIterations, getEvalRunSteps },
    runId: args.runId,
    ctx: args.ctx,
    limit: MAX_SCREENSHOTS,
    logger: args.logger,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  if (evidence.length === 0) return 0;

  try {
    await client.files.uploadV2({
      channel_id: args.channelId,
      thread_ts: args.threadTs,
      initial_comment: 'Here is what it looked like:',
      file_uploads: evidence.map((image) => ({
        file: image.bytes,
        filename: image.filename,
        title: image.caption,
      })),
    });
    return evidence.length;
  } catch (error) {
    // The outcome message is already correct and posted. This was the extra.
    args.logger.warn(`Could not upload run evidence for ${args.runId}: ${error}`);
    return 0;
  }
}
