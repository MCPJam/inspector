/**
 * Slack's binding to the shared connect-link mint.
 *
 * The transport (timeout, TIMEOUT/NETWORK error mapping, the SyntaxError-only
 * JSON-parse guard) and the origin/HTTPS validation now live in
 * `@mcpjam/surface-core`, verified there by its own tests. What stays HERE:
 *
 *   - THE WIRE SHAPE. `/api/slack/link/session` is Slack's OWN, older
 *     account-linking bridge (`server/routes/slack-link/index.ts`) — a
 *     completely separate OAuth flow from the generic `/api/surface-link/
 *     session` discord-app calls, and it expects `{teamId, slackUserId}`,
 *     not the generic `{surfaceKind, surfaceTenantId, surfaceUserId}` body.
 *     `mintConnectUrl`'s `body` override exists for exactly this.
 *   - The bot's OWN `slk_` credential resolution (never the environment-root
 *     service token — see below).
 *   - The multi-source origin allowlist, because the bridge mints from its
 *     OWN public origin setting, which can differ from the API origin.
 */
import { mintConnectUrl as mintConnectUrlCore } from '@mcpjam/surface-core';
import { InstallationBackendError } from '../installations/backend-client.js';

/**
 * Origins a connect link may legitimately live on.
 *
 * NOT just the API origin. The bridge mints the URL from its own
 * `SLACK_LINK_PUBLIC_ORIGIN` (falling back to `CLI_AUTH_PUBLIC_ORIGIN`), which
 * is a DIFFERENT setting from the one the bot calls — they coincide in our
 * deployment and diverge in local setups and any split-origin install. Pinning
 * to the API origin alone would reject a perfectly good link and make account
 * linking impossible wherever they differ. Malformed/missing entries are
 * dropped by the core's own normalization — narrowing the allowlist, never
 * widening it.
 *
 * @param {string} baseUrl the API origin the bot just called
 * @returns {string[]}
 */
function connectOrigins(baseUrl) {
  return /** @type {string[]} */ (
    [
      baseUrl,
      process.env.MCPJAM_SLACK_LINK_ORIGIN,
      process.env.SLACK_LINK_PUBLIC_ORIGIN,
      // The bridge resolves `SLACK_LINK_PUBLIC_ORIGIN ?? CLI_AUTH_PUBLIC_ORIGIN`,
      // so a deployment that only sets the documented fallback mints from THIS
      // origin. Omitting it here rejected every link on such a deployment.
      process.env.CLI_AUTH_PUBLIC_ORIGIN,
      process.env.MCPJAM_APP_URL,
    ].filter(Boolean)
  );
}

/**
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts] `timeoutMs`
 *   exists so a test can drive the abort path in milliseconds instead of
 *   waiting out the real deadline; production never passes it.
 * @returns {Promise<string>}
 */
export async function mintConnectUrl(ctx, opts = {}) {
  const baseUrl = (process.env.MCPJAM_BASE_URL || 'https://app.mcpjam.com').replace(/\/+$/, '');
  // The bot's own `slk_` credential — the SAME one it presents on /api/v1.
  // The bridge verifies it against the stored hash, so the bot never needs
  // (and must never hold) the inspector's environment-root service token.
  const serviceToken = process.env.MCPJAM_SLACK_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new InstallationBackendError('MCPJAM_SLACK_SERVICE_TOKEN is required to mint a connect link.', {
      code: 'CONFIG',
    });
  }
  return mintConnectUrlCore({
    baseUrl,
    token: serviceToken,
    path: '/api/slack/link/session',
    body: { teamId: ctx.teamId, slackUserId: ctx.slackUserId },
    origins: connectOrigins(baseUrl),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}
