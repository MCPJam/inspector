import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { registerListeners } from './listeners/index.js';

/**
 * Bolt's DEBUG level logs full Slack payloads — message text, user ids,
 * channel ids — so it must be opt-in, not the default. Anything hosted
 * (Railway) runs at INFO unless someone deliberately asks for more.
 */
const LOG_LEVELS = new Set(Object.values(LogLevel));
const requested = (process.env.SLACK_LOG_LEVEL || '').toLowerCase();
const logLevel = /** @type {LogLevel} */ (
  LOG_LEVELS.has(/** @type {LogLevel} */ (requested)) ? requested : LogLevel.INFO
);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel,
  // The bot's own replies must reach the message listener: a thread's next
  // turn re-reads history, and `sayStream` output arrives as a bot message.
  ignoreSelf: false,
});

registerListeners(app);

(async () => {
  await app.start();
  app.logger.info(`MCPJam Slack app is running! (log level: ${logLevel})`);
})();
