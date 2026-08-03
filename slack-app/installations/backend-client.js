/**
 * Thin client for the MCPJam backend's Slack service-token routes.
 *
 * The bot holds no database. Every install lookup, write, and revoke is one
 * of these calls, authenticated with `INSPECTOR_SERVICE_TOKEN` — the same
 * infrastructure-peer credential the inspector server uses. There is no user
 * identity involved at this layer at all.
 *
 * Env:
 *   MCPJAM_CONVEX_HTTP_URL   — the Convex HTTP origin (e.g. https://…convex.site)
 *   INSPECTOR_SERVICE_TOKEN  — server-to-server credential
 */

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Distinguishes the two failure modes that must NEVER be conflated:
 * `notInstalled` (authoritative — the workspace is not installed) from a
 * transport/backend failure (retryable). Telling a workspace it is
 * uninstalled because of a network blip is the failure this type prevents.
 */
export class InstallationBackendError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'InstallationBackendError';
    this.status = opts.status;
    this.code = opts.code;
  }
}

function getBackendConfig() {
  const baseUrl = (process.env.MCPJAM_CONVEX_HTTP_URL || '').replace(/\/+$/, '');
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) {
    throw new InstallationBackendError(
      'MCPJAM_CONVEX_HTTP_URL and INSPECTOR_SERVICE_TOKEN must be set to use OAuth installs.',
      { code: 'CONFIG' },
    );
  }
  return { baseUrl, serviceToken };
}

/** True when OAuth-mode config is present; drives socket-vs-HTTP mode selection. */
export function hasBackendConfig() {
  return Boolean(process.env.MCPJAM_CONVEX_HTTP_URL && process.env.INSPECTOR_SERVICE_TOKEN);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<any>}
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
        // Header form, not bearer: `lib/serviceToken.ts` reserves the bearer
        // slot for the delegated-identity flow, and new routes must not
        // adopt a convention where the same header can be a user OR a service.
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
      // A non-JSON body is only tolerable when the status already tells the
      // story. A mid-body abort must NOT be laundered into "empty success".
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok) {
      throw new InstallationBackendError(payload?.error || `Backend error (${response.status})`, {
        status: response.status,
        code: payload?.code,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof InstallationBackendError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new InstallationBackendError(
      aborted ? `Backend request timed out after ${REQUEST_TIMEOUT_MS}ms` : `Backend request failed: ${error}`,
      { code: aborted ? 'TIMEOUT' : 'NETWORK' },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @typedef {Object} StoredInstallationRecord
 * @property {Record<string, any>} installation  The Bolt Installation, verbatim.
 * @property {string} botUserId
 * @property {boolean} isLegacyWorkspace
 * @property {string} [enterpriseId]
 */

/**
 * Read one workspace's installation.
 *
 * Returns null ONLY when the backend authoritatively says the workspace is
 * not installed (or is revoked). A transport failure throws — callers must
 * not turn "we could not ask" into "you are not installed".
 *
 * @param {string} teamId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<StoredInstallationRecord | null>}
 */
export async function fetchInstallationRecord(teamId, opts = {}) {
  const payload = await post('/slack/installations/fetch', { teamId }, opts);
  const installation = payload?.installation;
  if (!installation || typeof installation !== 'object') return null;
  return {
    installation,
    botUserId: String(payload?.botUserId ?? ''),
    isLegacyWorkspace: payload?.isLegacyWorkspace === true,
    ...(payload?.enterpriseId ? { enterpriseId: String(payload.enterpriseId) } : {}),
  };
}

/**
 * Persist a completed OAuth install.
 * @param {{ teamId: string, enterpriseId?: string, teamName: string, appId: string, botUserId: string, scopes: string[], installation: Record<string, unknown> }} args
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function storeInstallationRecord(args, opts = {}) {
  return post('/slack/installations/upsert', args, opts);
}

/**
 * Revoke a workspace's installation.
 * @param {string} teamId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function revokeInstallationRecord(teamId, opts = {}) {
  return post('/slack/installations/revoke', { teamId }, opts);
}
