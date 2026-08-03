import { RUN_SUITE_ACTION_ID } from '../views/agent-reply-builder.js';
import { handleFeedbackButton } from './feedback-buttons.js';
import { handleRunSuiteButton } from './run-suite-button.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);
  app.action(RUN_SUITE_ACTION_ID, handleRunSuiteButton);
}
