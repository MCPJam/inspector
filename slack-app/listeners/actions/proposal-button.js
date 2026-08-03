/**
 * The click that authorizes a spend.
 *
 * The agent proposed; this is the person saying yes. Three things are true here
 * and each one is load-bearing:
 *
 *   1. THE CLICKER IS THE AUTHORIZER. The target is resolved for whoever
 *      clicked — not for whoever's message caused the proposal — so the server
 *      mints a delegated token for THEM and re-checks their org membership. A
 *      person who was removed from the org, or who never had access to the
 *      thread's project, cannot spend through a button left in a channel.
 *   2. THE CLICK CARRIES ONLY AN ID. What the action does comes from the
 *      persisted proposal. Anyone able to post in the workspace can mint a
 *      Block Kit button with any `value`; treating that value as instructions
 *      would make the whole approval gate decorative.
 *   3. THE TRANSITION IS DURABLE. `proposed → executing` is claimed server-side,
 *      so a double-click races there and exactly one caller wins. The loser is
 *      told, not billed.
 */
import { executeProposedAction, McpjamApiError } from '../../agent/mcpjam-client.js';
import { tryslackContextFrom } from '../../agent/slack-context.js';
import { resolveTurnTarget } from '../../agent/turn-target.js';

/**
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} args
 * @returns {Promise<void>}
 */
export async function handleProposalButton({ ack, body, client, context, logger, action }) {
  await ack();

  const ctx = tryslackContextFrom({ body, context });
  if (!ctx) {
    logger.warn('Dropping an approval click with no resolvable team/user id.');
    return;
  }

  const userId = ctx.slackUserId;
  const channelId = /** @type {string} */ (body.channel?.id);
  // The button sits on the bot's reply, which is itself a thread reply.
  // `chat.postMessage` wants the PARENT ts.
  const parentTs = /** @type {string} */ (body.message?.thread_ts ?? body.message?.ts);
  const actionId = action.value;
  if (!actionId || !channelId) return;

  /** @param {string} text */
  const tellClicker = (text) =>
    client.chat.postEphemeral({ channel: channelId, user: userId, thread_ts: parentTs, text });

  // Reauthorize the CLICKER. This is the same resolution the turn used, run
  // again for a different person — which is the point.
  let target;
  try {
    target = await resolveTurnTarget(ctx, { channelId, threadTs: parentTs });
  } catch (error) {
    logger.error(`Could not resolve the approval target: ${error}`);
    await tellClicker(':warning: I could not check your MCPJam access just now. Try again in a moment.');
    return;
  }
  if (target.mode === 'unlinked') {
    await tellClicker(':link: Connect your MCPJam account (in my Home tab) before approving this.');
    return;
  }
  if (target.mode === 'needs_project') {
    await tellClicker(':open_file_folder: Pick a default MCPJam project (in my Home tab) before approving this.');
    return;
  }

  const runCtx = { ...ctx, mode: target.mode, projectId: target.projectId };

  let outcome;
  try {
    outcome = await executeProposedAction(actionId, runCtx);
  } catch (error) {
    logger.error(`Approved action ${actionId} failed: ${error}`);
    if (error instanceof McpjamApiError && error.status === 409) {
      // Someone else's click won the race, or this one was redelivered. Not a
      // failure: say so plainly rather than implying something broke.
      await tellClicker(':information_source: That action is already under way.');
      return;
    }
    await tellClicker(
      error instanceof McpjamApiError
        ? error.friendlyMessage
        : ':warning: That did not go through. Try again in a moment.',
    );
    return;
  }

  // Announce IN THREAD, not ephemerally: a spend everyone in the conversation
  // can see is a spend nobody has to wonder about, and it names who approved it.
  const url = typeof outcome.result?.run?.url === 'string' ? outcome.result.run.url : null;
  try {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentTs,
      text: url
        ? `:white_check_mark: Approved by <@${userId}> — <${url}|follow it here>.`
        : `:white_check_mark: Approved by <@${userId}>, and it's away.`,
    });
  } catch (error) {
    // The action HAPPENED. A failed announcement is cosmetic and must not be
    // retried into a second spend.
    logger.error(`Approved action ${actionId} ran but announcing it failed: ${error}`);
  }
}
