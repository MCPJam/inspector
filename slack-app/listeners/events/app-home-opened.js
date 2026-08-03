import { mintConnectUrl } from '../../agent/connect-link.js';
import { listProjects } from '../../agent/mcpjam-client.js';
import { tryslackContextFrom } from '../../agent/slack-context.js';
import { fetchAccountLink, hasPerUserAuth } from '../../agent/turn-target.js';
import { buildAppHomeView } from '../views/app-home-builder.js';

const SUGGESTED_PROMPTS = [
  {
    title: 'Create an eval suite',
    message: 'Create an eval suite from this conversation',
  },
  {
    title: 'List my suites',
    message: 'What eval suites does my project have?',
  },
  {
    title: 'Check a run',
    message: 'How did my latest eval run go?',
  },
];

/**
 * Handle app_home_opened events. Under agent_view, this event fires for both
 * the Home tab and the Messages tab (the agent DM). Branch on event.tab:
 *   - 'messages' → pin suggested prompts to the top of the DM
 *   - 'home'     → publish the App Home Block Kit view
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'app_home_opened'>} args
 * @returns {Promise<void>}
 */
export async function handleAppHomeOpened({ body, client, event, context, logger }) {
  try {
    if (event.tab === 'messages') {
      await client.assistant.threads.setSuggestedPrompts(
        // Under agent_view, suggested prompts pin to the top of the Messages tab —
        // no thread_ts is required. Cast until @slack/bolt's types catch up.
        /** @type {import('@slack/web-api').AssistantThreadsSetSuggestedPromptsArguments} */ ({
          channel_id: event.channel,
          title: 'What should we test?',
          prompts: SUGGESTED_PROMPTS,
        }),
      );
      return;
    }

    const ctx = tryslackContextFrom({ body, context, event });
    if (!ctx) return;

    // Legacy/dev deployments have no per-user auth at all — showing a
    // connect button that leads nowhere would be worse than showing none.
    if (!hasPerUserAuth()) {
      await client.views.publish({
        user_id: ctx.slackUserId,
        view: buildAppHomeView({ connected: true, projectsError: false, projects: [] }),
      });
      return;
    }

    const link = await fetchAccountLink(ctx.teamId, ctx.slackUserId).catch(() => null);
    if (!link) {
      // Minted per render so the 10-minute clock starts when the user is
      // actually looking at the button.
      const connectUrl = await mintConnectUrl(ctx).catch((error) => {
        logger.warn(`Could not mint a connect URL: ${error}`);
        return undefined;
      });
      await client.views.publish({
        user_id: ctx.slackUserId,
        view: buildAppHomeView({ connected: false, ...(connectUrl ? { connectUrl } : {}) }),
      });
      return;
    }

    // The project list comes from the USER's credentials, so it is exactly
    // what they may act in — never a superset borrowed from the bot, which
    // would offer projects the picker could not actually save.
    /** @type {Array<{ id: string, name: string }>} */
    let projects = [];
    let projectsError = false;
    try {
      projects = await listProjects({ ...ctx, mode: 'user', projectId: link.defaultProjectId ?? undefined });
    } catch (error) {
      logger.warn(`Could not list projects for the App Home picker: ${error}`);
      projectsError = true;
    }

    await client.views.publish({
      user_id: ctx.slackUserId,
      view: buildAppHomeView({
        connected: true,
        projects,
        defaultProjectId: link.defaultProjectId ?? null,
        projectsError,
      }),
    });
  } catch (e) {
    logger.error(`Failed to handle app_home_opened: ${e}`);
  }
}
