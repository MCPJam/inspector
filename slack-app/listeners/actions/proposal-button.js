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
import { friendlyMessage as slackFriendlyMessage } from '../../render/slack.js';
import { escapeSlackText } from '../views/agent-reply-builder.js';
import { announceAndWatchJourneyRun } from './journey-run-watcher.js';
import { postRunEvidence } from './run-evidence.js';
import { announceAndWatchRun, isFailedOutcome } from './run-watcher.js';

/**
 * What to say once the action has actually run.
 *
 * KIND FIRST. The server tells us what the approved action does — start,
 * cancel, generate, schedule, external — so the copy stays truthful for
 * operations this build has never heard of. The operation-name branch below is
 * the mixed-version fallback for a server that predates `kind`; past that, an
 * unknown kind gets deliberately vague copy rather than a confident guess.
 *
 * A URL wins over the copy when there is one, because "follow it here" is the
 * most useful thing we can say — but only when the SERVER built it. A link
 * assembled here would need to know each operation's result shape.
 *
 * @param {{ operation: string, kind?: string | null, resource?: { url?: string } | null, runUrl?: string | null }} outcome
 * @param {string} userId
 */
export function announcementFor(outcome, userId) {
  const url =
    (outcome.resource && typeof outcome.resource.url === 'string' ? outcome.resource.url : null) ??
    outcome.runUrl ??
    null;

  switch (outcome.kind) {
    case 'cancel':
      // KIND WINS over any resource URL. A cancel that also returns a resource
      // should still say "Cancelled", not "Approved — follow it here".
      return `:white_check_mark: Cancelled by <@${userId}>.`;
    case 'generate':
      return `:white_check_mark: Approved by <@${userId}> — the cases are being generated.`;
    case 'schedule':
      // Nothing started. Saying "it's away" here would have the user watching
      // for a run that will not appear until the next interval.
      return `:white_check_mark: Approved by <@${userId}> — the schedule is updated.`;
    case 'external':
      return `:white_check_mark: Approved by <@${userId}> — the tool ran.`;
    case 'start':
      if (url) return `:white_check_mark: Approved by <@${userId}> — <${url}|follow it here>.`;
      return `:white_check_mark: Approved by <@${userId}>, and it's away.`;
    default:
      break;
  }

  // URL fallback for kinds this build does not recognise (newer server).
  if (url) return `:white_check_mark: Approved by <@${userId}> — <${url}|follow it here>.`;

  // A kind we do not recognise means a NEWER server, and the operation-name
  // table below is older than the kind vocabulary — consulting it would let a
  // brand-new action be announced as "it's away" on the strength of a name
  // this build happens to recognise. Claim nothing instead.
  if (outcome.kind != null) {
    return `:white_check_mark: Approved by <@${userId}>.`;
  }

  // No `kind` at all — an OLDER server. Fall back to the operation names this
  // build knows, then to copy that claims nothing.
  if (outcome.operation === 'cancel_eval_run') {
    return `:white_check_mark: Cancelled by <@${userId}>.`;
  }
  if (outcome.operation === 'generate_eval_cases') {
    return `:white_check_mark: Approved by <@${userId}> — the cases are being generated.`;
  }
  if (outcome.operation === 'run_eval_suite' || outcome.operation === 'run_eval_case') {
    return `:white_check_mark: Approved by <@${userId}>, and it's away.`;
  }
  return `:white_check_mark: Approved by <@${userId}>.`;
}

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

  /**
   * Telling the clicker must never THROW. Slack refuses `chat.postEphemeral`
   * in ordinary situations — the clicker not being a channel member, most
   * commonly — and this is awaited on the failure path, after a spend may
   * already have happened. An escape there turns a reported failure into an
   * unhandled one.
   * @param {string} text
   */
  const tellClicker = async (text) => {
    try {
      await client.chat.postEphemeral({ channel: channelId, user: userId, thread_ts: parentTs, text });
    } catch (error) {
      logger.error(`Could not tell <@${userId}> about their approval click: ${error}`);
    }
  };

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
    if (error instanceof McpjamApiError && (error.code === 'VALIDATION_ERROR' || error.code === 'NOT_FOUND')) {
      // The offer is gone — expired (proposals live an hour, deliberately, so
      // nobody approves something whose context everyone has forgotten) or
      // withdrawn by a deploy. The server's own wording is specific and already
      // user-facing; the generic "something went wrong" would send someone
      // hunting for a fault that does not exist. Escaped all the same: today
      // these messages are static server constants, but this seam is one
      // server change away from echoing request- or model-shaped content.
      await tellClicker(`:hourglass: ${escapeSlackText(error.message)} `.trim());
      return;
    }
    await tellClicker(
      error instanceof McpjamApiError
        ? slackFriendlyMessage(error)
        : ':warning: That did not go through. Try again in a moment.',
    );
    return;
  }

  // Announce IN THREAD, not ephemerally: a spend everyone in the conversation
  // can see is a spend nobody has to wonder about, and it names who approved it.
  //
  // The wording follows the action's KIND, which the server sends. "It's away"
  // is true of a run and false of a cancellation, and telling someone their
  // cancel started something is the kind of small lie that costs trust in every
  // later message. Switching on the kind rather than the operation name is what
  // lets a new gated operation get truthful copy without a bot deploy; the
  // operation-name ternary stays as the mixed-version fallback for a server
  // that predates `kind`.
  const text = announcementFor(outcome, userId);
  try {
    // A run gets a LIVE message: the same "running… → here's how it went"
    // surface the retired Run-it button gave, now reached through the approval
    // path. Recognised by the server-sent resource type rather than by an
    // operation name, so a future op that also produces a run gets it free.
    if (outcome.resource?.type === 'eval_run' && outcome.resource.id && outcome.resource.url) {
      const runId = outcome.resource.id;
      await announceAndWatchRun(client, {
        runId,
        url: outcome.resource.url,
        ctx: runCtx,
        channelId,
        threadTs: parentTs,
        userId,
        logger,
        text: `:rocket: Approved by <@${userId}> — running… <${outcome.resource.url}|watch it here>.`,
        // Screenshots land in the thread once the run is done — and only for
        // the FAILED outcome, whose message says "see what broke". A passing
        // run's pictures are noise under a green verdict; worse, posting them
        // under a red one illustrates a failure with evidence of success.
        // Strictly additive: the watcher has already posted the outcome by
        // the time this runs, and every failure inside it is logged and
        // skipped.
        onTerminal: async (run) => {
          if (!isFailedOutcome(run)) return;
          await postRunEvidence(client, {
            runId,
            ctx: runCtx,
            channelId,
            threadTs: parentTs,
            logger,
          });
        },
      });
      return;
    }
    // A JOURNEY run gets the same live surface, through its own watcher — the
    // status vocabulary, verdict location, and evidence shape all differ from
    // eval runs (see surface-core's journey-run-watcher header), so routing it
    // into the eval watcher would report a rate-limited fan-out as a pass.
    // Same recognition rule as above: the server-sent resource TYPE.
    if (outcome.resource?.type === 'journey_run' && outcome.resource.id && outcome.resource.url) {
      await announceAndWatchJourneyRun(client, {
        runId: outcome.resource.id,
        url: outcome.resource.url,
        ctx: runCtx,
        channelId,
        threadTs: parentTs,
        userId,
        logger,
      });
      return;
    }
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: parentTs,
      text,
    });
  } catch (error) {
    // The action HAPPENED. A failed announcement is cosmetic and must not be
    // retried into a second spend.
    logger.error(`Approved action ${actionId} ran but announcing it failed: ${error}`);
  }
}
