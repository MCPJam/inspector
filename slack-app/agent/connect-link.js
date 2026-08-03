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
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new InstallationBackendError('INSPECTOR_SERVICE_TOKEN is required to mint a connect link.', {
      code: 'CONFIG',
    });
  }
  return { baseUrl, serviceToken };
}

/** Loopback is the one place a plain-http bridge is legitimate (local dev). */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Reject anything that is not an absolute URL on the bridge's own origin.
 *
 * Same-origin is the check that carries the weight: it pins protocol, host and
 * port in one comparison, so a response that redirects the user somewhere else
 * cannot reach a button. The explicit HTTPS test is there for the case
 * same-origin cannot catch — a bridge configured over plain http in an
 * environment that is not local — because this URL carries a link session that
 * proves a Slack identity.
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

  let expected;
  try {
    expected = new URL(baseUrl);
  } catch {
    return reject('the configured MCPJAM_BASE_URL is not a valid URL');
  }

  let url;
  try {
    // No `base` argument on purpose — supplying one would silently RESOLVE a
    // relative path against our origin instead of rejecting it, which is the
    // opposite of what this check is for.
    url = new URL(candidate);
  } catch {
    return reject('it is not an absolute URL');
  }

  if (url.origin !== expected.origin) return reject('it points at a different origin');
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
        'x-inspector-service-token': serviceToken,
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
