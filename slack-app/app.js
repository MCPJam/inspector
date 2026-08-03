import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';

import { hasBackendConfig } from './installations/backend-client.js';
import { BOT_SCOPES } from './installations/bot-scopes.js';
import { convexInstallationStore } from './installations/store.js';
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

/**
 * MODE SELECTION BY CONFIG PRESENCE.
 *
 * Distributed (hosted): OAuth over Bolt's HTTP receiver. Bolt owns
 * `/slack/install` and `/slack/oauth_redirect`, signature verification, retry
 * headers, and the 3-second ack; per-workspace tokens come from the
 * Convex-backed installation store.
 *
 * Local dev: socket mode with one workspace's tokens from env — no public URL
 * and no registered OAuth app needed to iterate.
 *
 * The mode is DERIVED from config rather than set by a separate flag, so the
 * two can never disagree: a deployment that has OAuth credentials always
 * uses them.
 */
const OAUTH_ENV_KEYS = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_STATE_SECRET'];
const presentOauthKeys = OAUTH_ENV_KEYS.filter((key) => Boolean(process.env[key]));
if (presentOauthKeys.length > 0 && presentOauthKeys.length < OAUTH_ENV_KEYS.length) {
  // PARTIAL config is a misconfiguration, not a mode. Falling back to socket
  // mode here would silently stop serving /slack/events and /slack/install on
  // a hosted deployment — the app would look healthy while every install and
  // every event 404'd.
  const missing = OAUTH_ENV_KEYS.filter((key) => !process.env[key]);
  throw new Error(
    `Slack OAuth is partially configured: ${presentOauthKeys.join(', ')} set but ${missing.join(', ')} missing. ` +
      'Set all three for OAuth mode, or none for socket mode.',
  );
}
const oauthConfigured = presentOauthKeys.length === OAUTH_ENV_KEYS.length;

if (oauthConfigured && !process.env.SLACK_SIGNING_SECRET) {
  // Deliberately NOT one of the three mode-selecting keys: socket mode does not
  // need it, so its presence must not imply OAuth. But in OAuth mode it is the
  // only thing standing between the public `/slack/events` endpoint and anyone
  // who can POST to it, so booting without it is not an option.
  throw new Error(
    'Slack OAuth is configured but SLACK_SIGNING_SECRET is missing — inbound request signatures could not be verified.',
  );
}

if (oauthConfigured && !hasBackendConfig()) {
  // Fail fast rather than boot: with OAuth credentials but no backend, every
  // install would succeed at Slack and then be dropped on the floor, and
  // every event would fail authorization with nothing pointing at the cause.
  throw new Error(
    'Slack OAuth is configured but MCPJAM_CONVEX_HTTP_URL / SLACK_SERVICE_TOKEN are missing — ' +
      'installations could be neither stored nor read.',
  );
}

/**
 * Bolt refuses BOTH a custom `authorize` and OAuth installer options
 * (`@slack/bolt/dist/App.js`), and given installer options it derives
 * `authorize` from `installationStore.fetchInstallation`. So there is
 * deliberately no `authorize` here — the installation store IS the
 * authorization path.
 *
 * `scopes` is passed EXPLICITLY and is load-bearing: HTTPReceiver defaults it
 * to `undefined` and forwards `scopes ?? []`, so omitting it yields an install
 * URL requesting zero bot scopes. That install SUCCEEDS and then fails every
 * API call with `missing_scope`, per workspace, with nothing at install time
 * to point at the cause.
 */
const app = oauthConfigured
  ? new App({
      signingSecret: process.env.SLACK_SIGNING_SECRET,
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_STATE_SECRET,
      scopes: [...BOT_SCOPES],
      installationStore: convexInstallationStore,
      logLevel,
      ignoreSelf: false,
      installerOptions: {
        // Sign in with Slack is a SEPARATE OAuth flow, owned by the
        // inspector's link bridge. Slack rejects an authorize request that
        // mixes SIWS user scopes with bot scopes, so this URL must never grow
        // `openid`/`profile`.
        directInstall: true,
      },
    })
  : new App({
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
  if (oauthConfigured) {
    // Railway injects PORT. `start()` takes no argument in socket mode, where
    // the process dials out and serves no HTTP — passing `undefined` there is
    // a different overload, not the same call with an empty port.
    const port = Number(process.env.PORT || 3000);
    await app.start(port);
    app.logger.info(`MCPJam Slack app is running in OAuth mode on :${port} (log level: ${logLevel})`);
    return;
  }
  await app.start();
  app.logger.info(`MCPJam Slack app is running in socket mode (log level: ${logLevel})`);
})();
