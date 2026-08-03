import { McpjamApiError } from '../../agent/mcpjam-client.js';
import { runTurnForEvent } from '../../agent/turn-runner.js';
import { buildCreatedResourceBlocks } from '../views/agent-reply-builder.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * Shared body for both event listeners: run the turn (deduped + serialized
 * per thread in the runner) and post the reply with Run-it buttons for any
 * suites the turn created.
 *
 * @param {{
 *   client: import('@slack/web-api').WebClient,
 *   ctx: import('../../agent/slack-context.js').SlackContext,
 *   context: import('@slack/bolt').Context,
 *   logger: import('@slack/bolt').Logger,
 *   say: Function,
 *   sayStream: Function,
 *   setStatus: Function,
 *   channelId: string,
 *   threadTs: string,
 *   triggerTs: string,
 *   eventId?: string,
 *   isThread: boolean,
 *   fallbackText: string,
 * }} args
 * @returns {Promise<void>}
 */
export async function runAndReply(args) {
  const { client, context, logger, say, sayStream, setStatus } = args;
  try {
    // Posting is passed INTO the runner so it happens inside the per-thread
    // queue — the next turn's history must already contain this reply.
    await runTurnForEvent({
      client,
      ctx: args.ctx,
      channelId: args.channelId,
      threadTs: args.threadTs,
      triggerTs: args.triggerTs,
      ...(args.eventId ? { eventId: args.eventId } : {}),
      isThread: args.isThread,
      botUserId: /** @type {string | undefined} */ (context.botUserId),
      fallbackText: args.fallbackText,
      // Best-effort: the status indicator is cosmetic, so a Slack hiccup
      // here must never cost the user their answer.
      onStart: async () => {
        try {
          await setStatus({
            status: 'Working on it…',
            loading_messages: [
              'Reading the thread…',
              'Checking your MCPJam project…',
              'Drafting eval cases…',
              'Talking to the MCPJam agent…',
            ],
          });
        } catch (error) {
          logger.warn(`Could not set the assistant status: ${error}`);
        }
      },
      onResult: async (result) => {
        const streamer = sayStream();
        await streamer.append({
          markdown_text: result.reply || 'Done — though I have nothing to add.',
        });
        await streamer.stop({
          blocks: [...buildCreatedResourceBlocks(result.createdResources), ...buildFeedbackBlocks()],
        });
      },
      // A redelivery of an event we already answered: re-post the STORED
      // reply rather than re-running the turn. Plain `say` rather than the
      // streamer — there is nothing to stream, the text already exists, and
      // the note tells the user why an old answer just reappeared.
      onReplay: async (envelope) => {
        await say({
          text: envelope.reply || 'Done — though I have nothing to add.',
          thread_ts: args.threadTs,
          blocks: [
            ...buildCreatedResourceBlocks(envelope.createdResources),
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '_Slack redelivered this message; this is the answer I already produced._',
                },
              ],
            },
          ],
        });
      },
    });
  } catch (error) {
    logger.error(`Agent turn failed: ${error}`);
    const text =
      error instanceof McpjamApiError
        ? error.friendlyMessage
        : ':warning: Something went wrong. Try again in a moment.';
    await say({ text, thread_ts: args.threadTs });
  }
}
