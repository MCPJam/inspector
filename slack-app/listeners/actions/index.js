import { RUN_SUITE_ACTION_ID } from '../views/agent-reply-builder.js';
import { CONNECT_ACTION_ID, PROJECT_PICKER_ACTION_ID, UNLINK_ACTION_ID } from '../views/connect-builder.js';
import { handleConnectClick, handleProjectPicker, handleUnlink } from './account-actions.js';
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
  app.action(PROJECT_PICKER_ACTION_ID, handleProjectPicker);
  app.action(UNLINK_ACTION_ID, handleUnlink);
  // URL buttons still deliver an interaction; without a listener Bolt logs an
  // "unhandled request" warning for every click.
  app.action(CONNECT_ACTION_ID, handleConnectClick);
  app.action('mcpjam_open_home', handleConnectClick);
}
