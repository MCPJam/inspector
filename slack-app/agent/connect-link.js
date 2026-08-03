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
