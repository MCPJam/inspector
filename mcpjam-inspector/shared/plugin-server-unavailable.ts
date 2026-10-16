/**
 * Transient SSE data part naming the plugin servers a chat turn ran without:
 * each was admitted, then was refused, failed to start, connect or
 * authenticate, or did not list its tools in time, so the turn kept its other
 * servers and skills instead of failing whole. The browser says so through
 * the plugin notice and Logs.
 *
 * Carries ids, a categorical reason and an optional scope challenge. Raw
 * error text stays private because it can quote a credential.
 */
export const PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE =
  "data-plugin-server-unavailable" as const;

/** `needs_auth` when signing in again is the fix; `unreachable` otherwise. */
export type PluginServerUnavailableReason = "needs_auth" | "unreachable";

/** Non-secret fields from an insufficient-scope challenge, bound to this server. */
export interface PluginServerScopeChallenge {
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

export interface PluginServerUnavailable {
  serverId: string;
  reason: PluginServerUnavailableReason;
  scopeChallenge?: PluginServerScopeChallenge;
}

export interface PluginServerUnavailableDataPart {
  type: typeof PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE;
  data: {
    servers: PluginServerUnavailable[];
    /** The chat the turn belongs to, as in `history-notice.ts`. */
    chatSessionId?: string;
  };
}

const REASONS: ReadonlySet<string> = new Set(["needs_auth", "unreachable"]);

function isScopeChallenge(value: unknown): value is PluginServerScopeChallenge {
  if (!value || typeof value !== "object") return false;
  const challenge = value as Record<string, unknown>;
  return (
    (challenge.requiredScope === undefined ||
      typeof challenge.requiredScope === "string") &&
    (challenge.resourceMetadataUrl === undefined ||
      typeof challenge.resourceMetadataUrl === "string") &&
    Boolean(
      challenge.requiredScope?.trim() || challenge.resourceMetadataUrl?.trim(),
    )
  );
}

function isEntry(value: unknown): value is PluginServerUnavailable {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.serverId === "string" &&
    entry.serverId.length > 0 &&
    typeof entry.reason === "string" &&
    REASONS.has(entry.reason) &&
    (entry.scopeChallenge === undefined ||
      (entry.reason === "needs_auth" && isScopeChallenge(entry.scopeChallenge)))
  );
}

export function isPluginServerUnavailableDataPart(
  value: unknown,
): value is PluginServerUnavailableDataPart {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== PLUGIN_SERVER_UNAVAILABLE_DATA_PART_TYPE) return false;
  const data = candidate.data as Record<string, unknown> | null | undefined;
  return (
    !!data &&
    Array.isArray(data.servers) &&
    data.servers.length > 0 &&
    data.servers.every(isEntry) &&
    (data.chatSessionId === undefined ||
      (typeof data.chatSessionId === "string" && data.chatSessionId.length > 0))
  );
}
