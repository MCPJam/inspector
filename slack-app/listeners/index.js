import * as actions from './actions/index.js';
import * as events from './events/index.js';
import { tenantGuard } from './middleware/tenant-guard.js';
import * as views from './views/index.js';

/**
 * Register all Slack event, action, and view listeners.
 *
 * The tenant guard is installed as GLOBAL middleware, ahead of every
 * listener, so exactly one place decides whether a workspace may run a turn.
 * Per-listener checks would always be one forgotten `if` away from a gap, and
 * that gap would be a cross-tenant one.
 *
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function registerListeners(app) {
  app.use(tenantGuard);
  actions.register(app);
  events.register(app);
  views.register(app);
}
