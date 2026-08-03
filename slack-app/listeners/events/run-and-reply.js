import { mintConnectUrl } from '../../agent/connect-link.js';
import { McpjamApiError } from '../../agent/mcpjam-client.js';
import { runTurnForEvent } from '../../agent/turn-runner.js';
import { createThreadBinding, resolveTurnTarget } from '../../agent/turn-target.js';
import { buildCreatedResourceBlocks } from '../views/agent-reply-builder.js';
import { appHomeDeepLink, buildConnectBlocks, buildPickProjectBlocks } from '../views/connect-builder.js';
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
    // WHOSE credentials, and WHICH project. Resolved before any turn work so
    // an unlinked user is offered a connect button instead of a failure, and
    // a bound thread never re-resolves to a different project.
    const target = await resolveTurnTarget(args.ctx, {
      channelId: args.channelId,
      threadTs: args.threadTs,
    });

    if (target.mode === 'unlinked') {
      // Ephemeral in a channel so a connect prompt meant for one person does
      // not become a notification for everyone in the thread. In a DM there
      // is nobody else, and an ephemeral message there is easy to miss.
      const url = await mintConnectUrl(args.ctx);
      await postToRequester(args, {
        text: 'Connect your MCPJam account to get started.',
        blocks: buildConnectBlocks(url),
      });
      return;
    }

    if (target.mode === 'needs_project') {
      await postToRequester(args, {
        text: 'Pick a default MCPJam project to get started.',
        blocks: buildPickProjectBlocks(appHomeDeepLink(args.ctx.teamId, String(context.botId ?? context.appId ?? ''))),
      });
      return;
    }

    // A new conversation binds to the initiator's org/project. Everything
    // said in this thread afterwards belongs to that project, whoever says
    // it — the alternative is a thread that drifts between projects and lands
    // a suite somewhere nobody expected. First writer wins server-side, so a
    // race here resolves to one binding rather than the last writer's.
    const credentialCtx = { ...args.ctx, mode: target.mode, projectId: target.projectId };
    if (!target.boundThread && target.mode === 'user' && target.organizationId && target.projectId) {
      const binding = await createThreadBinding({
        teamId: args.ctx.teamId,
        channelId: args.channelId,
        threadTs: args.threadTs,
        organizationId: target.organizationId,
        projectId: target.projectId,
        initiatorSlackUserId: args.ctx.slackUserId,
      }).catch((error) => {
        // A thread that could not be bound still runs — losing the binding
        // costs stability across restarts, not correctness of THIS turn,
        // which is already clamped to the resolved project.
        logger.warn(`Could not bind thread to a project: ${error}`);
        return null;
      });
      if (binding && binding.projectId) credentialCtx.projectId = binding.projectId;
    }

    // Posting is passed INTO the runner so it happens inside the per-thread
    // queue — the next turn's history must already contain this reply.
    await runTurnForEvent({
      client,
      ctx: credentialCtx,
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

/**
 * Post to the person who triggered the turn, and only to them, when the
 * message is about THEIR account rather than the conversation. Channels get
 * an ephemeral; DMs get a normal message (there is nobody else to shield, and
 * ephemerals in a DM are easy to miss).
 *
 * @param {Parameters<typeof runAndReply>[0]} args
 * @param {{ text: string, blocks: unknown[] }} message
 */
async function postToRequester(args, message) {
  if (args.isThread) {
    await args.client.chat.postEphemeral({
      channel: args.channelId,
      user: args.ctx.slackUserId,
      thread_ts: args.threadTs,
      text: message.text,
      blocks: /** @type {any} */ (message.blocks),
    });
    return;
  }
  await args.say({
    text: message.text,
    thread_ts: args.threadTs,
    blocks: message.blocks,
  });
}
