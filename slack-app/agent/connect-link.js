/**
 * Mint a per-user connect URL from the inspector's link bridge.
 *
 * The URL is minted server-side, per user, and expires in ten minutes. The bot
 * only relays it: it holds no signing secret of its own, so a compromised bot
 * cannot forge a link URL for an arbitrary Slack user.
 */
import { InstallationBackendError } from '../installations/backend-client.js';

const REQUEST_TIMEOUT_MS = 10_000;

function bridgeConfig() {
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
  return { baseUrl, serviceToken };
}

/** Loopback is the one place a plain-http bridge is legitimate (local dev). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Origins a connect link may legitimately live on.
 *
 * NOT just the API origin. The bridge mints the URL from its own
 * `SLACK_LINK_PUBLIC_ORIGIN` (falling back to `CLI_AUTH_PUBLIC_ORIGIN`), which
 * is a DIFFERENT setting from the one the bot calls — they coincide in our
 * deployment and diverge in local setups and any split-origin install. Pinning
 * to the API origin alone would reject a perfectly good link and make account
 * linking impossible wherever they differ.
 *
 * So this is an allowlist rather than an equality test: still closed by
 * default, still refusing an origin nobody configured, but honest about the
 * fact that more than one of them is ours.
 *
 * @param {string} baseUrl the API origin the bot just called
 * @returns {Set<string>}
 */
function allowedConnectOrigins(baseUrl) {
  const configured = [
    baseUrl,
    process.env.MCPJAM_SLACK_LINK_ORIGIN,
    process.env.SLACK_LINK_PUBLIC_ORIGIN,
    // The bridge resolves `SLACK_LINK_PUBLIC_ORIGIN ?? CLI_AUTH_PUBLIC_ORIGIN`,
    // so a deployment that only sets the documented fallback mints from THIS
    // origin. Omitting it here rejected every link on such a deployment.
    process.env.CLI_AUTH_PUBLIC_ORIGIN,
    process.env.MCPJAM_APP_URL,
  ];
  /** @type {Set<string>} */
  const origins = new Set();
  for (const candidate of configured) {
    if (!candidate) continue;
    try {
      origins.add(new URL(candidate).origin);
    } catch {
      // A malformed optional setting narrows the allowlist; it must not widen
      // it and must not crash the mint.
    }
  }
  return origins;
}

/**
 * Reject anything that is not an absolute URL on a configured origin.
 *
 * The origin comparison carries the weight: `URL.origin` pins protocol, host
 * and port together, so neither a look-alike host nor a `user@evil.test`
 * userinfo trick can smuggle a foreign destination into a Block Kit button.
 * The explicit HTTPS test covers what the origin check cannot — a bridge
 * configured over plain http somewhere that is not local — because this URL
 * carries a link session that proves a Slack identity.
 *
 * @param {string} candidate
 * @param {string} baseUrl
 */
function assertConnectUrl(candidate, baseUrl) {
  /** @param {string} reason */
  const reject = (reason) => {
    // The URL itself is deliberately not logged or surfaced: it is a
    // single-use credential for a named user's link flow.
    throw new InstallationBackendError(`The connect link the bridge returned was not usable (${reason}).`);
  };

  const allowed = allowedConnectOrigins(baseUrl);
  if (allowed.size === 0) return reject('no valid MCPJAM origin is configured');

  let url;
  try {
    // No `base` argument on purpose — supplying one would silently RESOLVE a
    // relative path against our origin instead of rejecting it, which is the
    // opposite of what this check is for.
    url = new URL(candidate);
  } catch {
    return reject('it is not an absolute URL');
  }

  if (!allowed.has(url.origin)) return reject('it points at an origin we did not configure');
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return reject('it is not served over HTTPS');
  }
}

/**
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts] `timeoutMs`
 *   exists so a test can drive the abort path in milliseconds instead of
 *   waiting out the real deadline; production never passes it.
 * @returns {Promise<string>}
 */
export async function mintConnectUrl(ctx, opts = {}) {
  const { baseUrl, serviceToken } = bridgeConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/api/slack/link/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({ teamId: ctx.teamId, slackUserId: ctx.slackUserId }),
      signal: controller.signal,
    });
    /** @type {any} */
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok || typeof payload?.url !== 'string') {
      throw new InstallationBackendError(payload?.message || `Could not mint a connect link (${response.status})`, {
        status: response.status,
      });
    }
    // The URL goes straight into a Block Kit button, and Slack renders whatever
    // it is handed. An empty or relative value produces a dead button; an
    // off-origin one produces a WORKING button pointing somewhere else, which
    // is a credential-phishing link wearing our bot's face. Neither is worth
    // the risk of trusting the response shape, so pin it to the bridge origin
    // we just called — and to HTTPS, since this URL starts an identity flow.
    assertConnectUrl(payload.url, baseUrl);
    return payload.url;
  } catch (error) {
    if (error instanceof InstallationBackendError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new InstallationBackendError(
      aborted ? 'Connect-link request timed out' : `Connect-link request failed: ${error}`,
      {
        code: aborted ? 'TIMEOUT' : 'NETWORK',
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
