import { mintConnectUrl } from '../../agent/connect-link.js';
import { McpjamApiError } from '../../agent/mcpjam-client.js';
import { runTurnForEvent } from '../../agent/turn-runner.js';
import { createThreadBinding, resolveTurnTarget } from '../../agent/turn-target.js';
import { buildCreatedResourceBlocks } from '../views/agent-reply-builder.js';
import { appHomeDeepLink, buildConnectBlocks, buildPickProjectBlocks } from '../views/connect-builder.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';
import { buildProposalBlocks } from '../views/proposal-builder.js';

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
      // A failed mint must not fail the whole reply: the unlinked user would
      // then get NOTHING, which reads as the bot ignoring them. Degrade to the
      // buttonless copy instead.
      const url = await mintConnectUrl(args.ctx).catch((error) => {
        logger.error(`Could not mint a connect link: ${error}`);
        return null;
      });
      await postToRequester(args, {
        text: url ? 'Connect your MCPJam account to get started.' : "I couldn't prepare a connection link just now.",
        blocks: buildConnectBlocks(url),
      });
      return;
    }

    if (target.mode === 'needs_project') {
      // `appId` is what an App Home deep link needs; `botId` is a different
      // namespace (`B…`) and produces a link that opens nothing. Only build one
      // when we actually have the app id.
      const appId = typeof context.appId === 'string' ? context.appId : undefined;
      await postToRequester(args, {
        text: 'Pick a default MCPJam project to get started.',
        blocks: buildPickProjectBlocks(appId ? appHomeDeepLink(args.ctx.teamId, appId) : null),
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
        logger.error(`Could not bind thread to a project: ${error}`);
        return null;
      });
      if (!binding) {
        // FAIL the turn rather than running unbound. An unbound thread
        // re-resolves on every reply, so the next person to speak would get
        // THEIR default project and create resources somewhere the initiator
        // never chose — a silent cross-project write, which is worse than a
        // visible "try again".
        await say({
          text: ':warning: I could not pin this thread to a project. Try again in a moment.',
          thread_ts: args.threadTs,
        });
        return;
      }
      if (binding.projectId) credentialCtx.projectId = binding.projectId;
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
          blocks: [
            ...buildCreatedResourceBlocks(result.createdResources),
            ...buildProposalBlocks(result.proposedActions),
            ...buildFeedbackBlocks(),
          ],
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
            // The reply TEXT has to be a block too: `text` alone is only the
            // notification fallback, so a blocks-only replay would show the
            // suite links and the note with the answer itself missing.
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: (envelope.reply || 'Done — though I have nothing to add.').slice(0, 2900),
              },
            },
            ...buildCreatedResourceBlocks(envelope.createdResources),
            // Proposals replay too. They are still `proposed` server-side — the
            // approval never happened — so re-offering them is the difference
            // between a redelivery the user can act on and one that quietly
            // drops the action they were about to approve.
            ...buildProposalBlocks(envelope.proposedActions),
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: '_Slack redelivered this message; this is the answer I already produced._',
                },
              ],
            },
            ...buildFeedbackBlocks(),
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
    // A failed turn is not always an EMPTY turn: the runner attaches whatever
    // the server says was already persisted (suites, proposals) before the
    // failure. Showing those with the error is what keeps "ask again" from
    // reading as "start over" — the user can see what exists and, crucially,
    // what NOT to ask for a second time.
    const envelope = /** @type {any} */ (error)?.failureEnvelope;
    const salvaged =
      envelope && ((envelope.createdResources?.length ?? 0) > 0 || (envelope.proposedActions?.length ?? 0) > 0);
    if (salvaged) {
      await say({
        text,
        thread_ts: args.threadTs,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '_The turn failed partway, but this much was already created:_',
              },
            ],
          },
          ...buildCreatedResourceBlocks(envelope.createdResources ?? []),
          ...buildProposalBlocks(envelope.proposedActions ?? []),
        ],
      });
      return;
    }
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
  // `isThread` means "has a thread_ts", NOT "is a channel" — a threaded DM is
  // both. Ephemerals in a DM are easy to miss, and this is the ONLY response
  // the user gets, so branch on the channel type instead.
  const isDirectMessage = args.channelId.startsWith('D');
  if (args.isThread && !isDirectMessage) {
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
