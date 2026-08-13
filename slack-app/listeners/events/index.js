import { handleAppHomeOpened } from './app-home-opened.js';
import { handleAppUninstalled, handleTokensRevoked } from './app-lifecycle.js';
import { handleAppMentioned } from './app-mentioned.js';
import { handleMessage } from './message.js';

/**
 * Register event listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.event('app_home_opened', handleAppHomeOpened);
  app.event('app_mention', handleAppMentioned);
  app.event('message', handleMessage);
  // Installation lifecycle. These bypass the tenant guard by design (see
  // `tenant-guard.js`): they are how a workspace tells us to stop.
  app.event('app_uninstalled', handleAppUninstalled);
  app.event('tokens_revoked', handleTokensRevoked);
}
