/**
 * Durable claims over the backend's `/slack/claims/*` routes.
 *
 * The in-memory `EventDedupe` is a fast path, not a guarantee: it dies with
 * the process, so a Slack redelivery after a restart runs the turn again. And
 * even a perfect dedupe cannot help with the case where the turn finished,
 * persisted an eval suite, and then lost its reply — from which the only
 * choices are dropping the answer or re-running the work.
 *
 * A durable claim solves both by carrying the ANSWER: the claim is taken
 * before processing, and the reply envelope is stored on completion, so a
 * late redelivery replays the reply instead of re-running the turn.
 *
 * FAIL-CLOSED. Every helper here throws on a backend failure rather than
 * returning a "go ahead" default. A claim that silently degrades to "you own
 * it" turns one Slack event into two billed turns, which is precisely the
 * failure the claim exists to prevent — so an unreachable backend must stop
 * the event and let Slack's retry find a healthy process.
 */
import { InstallationBackendError } from './backend-client.js';

const REQUEST_TIMEOUT_MS = 10_000;

function getBackendConfig() {
  const baseUrl = (process.env.MCPJAM_CONVEX_HTTP_URL || '').replace(/\/+$/, '');
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) {
    throw new InstallationBackendError(
      'MCPJAM_CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN must be set to claim events.',
      { code: 'CONFIG' },
    );
  }
  return { baseUrl, serviceToken };
}

/** True when durable claims are available; false in local socket-mode dev. */
export function hasClaimBackend() {
  return Boolean(process.env.MCPJAM_CONVEX_HTTP_URL && process.env.INSPECTOR_SERVICE_TOKEN);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function post(path, body, opts = {}) {
  const { baseUrl, serviceToken } = getBackendConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-inspector-service-token': serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    /** @type {any} */
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok) {
      throw new InstallationBackendError(payload?.error || `Claim backend error (${response.status})`, {
        status: response.status,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof InstallationBackendError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new InstallationBackendError(
      aborted ? `Claim request timed out after ${REQUEST_TIMEOUT_MS}ms` : `Claim request failed: ${error}`,
      { code: aborted ? 'TIMEOUT' : 'NETWORK' },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {Object} ClaimResult
 * @property {'claimed' | 'inflight' | 'completed'} outcome
 * @property {any} resultEnvelope  Stored reply, present only for 'completed'.
 */

/**
 * Take the claim for `dedupeKey`.
 *
 * @param {string} dedupeKey  `${teamId}:${event_id}` — team-prefixed because
 *   Slack event ids are only unique within a workspace.
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<ClaimResult>}
 */
export async function claimEvent(dedupeKey, opts = {}) {
  const payload = await post('/slack/claims/claim', { dedupeKey }, opts);
  const outcome = payload?.outcome;
  if (outcome !== 'claimed' && outcome !== 'inflight' && outcome !== 'completed') {
    // An unrecognized outcome must not be read as permission to proceed.
    throw new InstallationBackendError(`Claim backend returned an unknown outcome: ${outcome}`);
  }
  return { outcome, resultEnvelope: payload?.resultEnvelope ?? null };
}

/**
 * Record the turn's outcome so a redelivery replays it instead of re-running.
 * @param {string} dedupeKey
 * @param {unknown} resultEnvelope
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function completeEvent(dedupeKey, resultEnvelope, opts = {}) {
  return post(
    '/slack/claims/complete',
    { dedupeKey, ...(resultEnvelope === undefined ? {} : { resultEnvelope }) },
    opts,
  );
}

/**
 * Drop a claim so the event can be processed again immediately.
 *
 * ONLY for work that provably did NOT happen. An "unsure" release is how a
 * paid mutation runs twice; for those, leave the claim and let its TTL expire.
 * @param {string} dedupeKey
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function releaseEvent(dedupeKey, opts = {}) {
  return post('/slack/claims/release', { dedupeKey }, opts);
}
