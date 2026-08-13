/**
 * Slack's binding to the MCPJam backend's service-token routes.
 *
 * The bot holds no database. Every install lookup, write, and revoke is one
 * of these calls, authenticated with `SLACK_SERVICE_TOKEN` — the bot's OWN
 * server-to-server credential, accepted by the backend's `/slack/*` routes
 * and NOTHING else. Deliberately not `INSPECTOR_SERVICE_TOKEN`: that token
 * also opens arbitrary user delegation and delegated-JWT minting, so holding
 * it here would make a compromised bot a compromised platform. There is no
 * user identity involved at this layer at all.
 *
 * The transport — timeout, the non-JSON body rule, the error envelope — comes
 * from `@mcpjam/surface-core`, and so does `InstallationBackendError`. That
 * shared class matters more than it looks: a second copy with the same name
 * would leave `instanceof` silently false across the seam, which is how a
 * fail-closed claim check quietly stops being fail-closed.
 *
 * Env:
 *   MCPJAM_CONVEX_HTTP_URL   — the Convex HTTP origin (e.g. https://…convex.site)
 *   SLACK_SERVICE_TOKEN  — the bot's own /slack/*-only credential
 */
import { createBackendClient, InstallationBackendError } from '@mcpjam/surface-core';

/**
 * Distinguishes the two failure modes that must NEVER be conflated:
 * `notInstalled` (authoritative — the workspace is not installed) from a
 * transport/backend failure (retryable). Telling a workspace it is
 * uninstalled because of a network blip is the failure this type prevents.
 */
export { InstallationBackendError };

/**
 * The shared Slack-scoped backend client. Exported so the claim helpers ride
 * the same credential and route prefix rather than assembling their own.
 */
export const backend = createBackendClient({
  surfaceKind: 'slack',
  routePrefix: '/slack',
  // Header form, not bearer: `lib/serviceToken.ts` reserves the bearer slot
  // for the delegated-identity flow, and new routes must not adopt a
  // convention where the same header can be a user OR a service.
  authHeaderName: 'x-slack-service-token',
  serviceTokenEnv: 'SLACK_SERVICE_TOKEN',
});

/** True when OAuth-mode config is present; drives socket-vs-HTTP mode selection. */
export function hasBackendConfig() {
  return Boolean(process.env.MCPJAM_CONVEX_HTTP_URL && process.env.SLACK_SERVICE_TOKEN);
}

/**
 * Names the two env vars an operator actually has to set. The core client's
 * own message is surface-neutral by necessity; this one is actionable.
 */
function assertBackendConfig() {
  if (!hasBackendConfig()) {
    throw new InstallationBackendError(
      'MCPJAM_CONVEX_HTTP_URL and SLACK_SERVICE_TOKEN must be set to use OAuth installs.',
      { code: 'CONFIG' },
    );
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
  assertBackendConfig();
  const payload = await backend.post('/slack/installations/fetch', { teamId }, opts);
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
  assertBackendConfig();
  return backend.post('/slack/installations/upsert', args, opts);
}

/**
 * Revoke a workspace's installation.
 * @param {string} teamId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function revokeInstallationRecord(teamId, opts = {}) {
  assertBackendConfig();
  return backend.post('/slack/installations/revoke', { teamId }, opts);
}
