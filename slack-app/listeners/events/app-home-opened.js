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
export async function handleAppHomeOpened({ client, event, context, logger }) {
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

    const userId = /** @type {string} */ (context.userId);
    const view = buildAppHomeView();
    await client.views.publish({ user_id: userId, view });
  } catch (e) {
    logger.error(`Failed to handle app_home_opened: ${e}`);
  }
}
