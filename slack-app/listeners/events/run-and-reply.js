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
 *   context: import('@slack/bolt').Context,
 *   logger: import('@slack/bolt').Logger,
 *   say: Function,
 *   sayStream: Function,
 *   setStatus: Function,
 *   channelId: string,
 *   threadTs: string,
 *   triggerTs: string,
 *   isThread: boolean,
 *   fallbackText: string,
 * }} args
 * @returns {Promise<void>}
 */
export async function runAndReply(args) {
  const { client, context, logger, say, sayStream, setStatus } = args;
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

    const result = await runTurnForEvent({
      client,
      channelId: args.channelId,
      threadTs: args.threadTs,
      triggerTs: args.triggerTs,
      isThread: args.isThread,
      botUserId: /** @type {string | undefined} */ (context.botUserId),
      fallbackText: args.fallbackText,
    });
    if (result === null) return; // duplicate Slack delivery — already handled

    const streamer = sayStream();
    await streamer.append({
      markdown_text: result.reply || 'Done — though I have nothing to add.',
    });
    await streamer.stop({
      blocks: [...buildCreatedResourceBlocks(result.createdResources), ...buildFeedbackBlocks()],
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
