import * as actions from './actions/index.js';
import * as events from './events/index.js';
import * as views from './views/index.js';

/**
 * Register all Slack event, action, and view listeners.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function registerListeners(app) {
  actions.register(app);
  events.register(app);
  views.register(app);
}
