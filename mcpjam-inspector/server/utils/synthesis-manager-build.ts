/**
 * Build a fully-configured `MCPClientManager` from a worker-safe runtime
 * descriptor.
 *
 * The synthetic-session durable runner has no live `Context` or user
 * bearer at job-execution time. At `runs/create` time the route adapter
 * resolves the per-server runtime material via the existing live
 * `authorizeBatch` / `createAuthorizedManager` path (which holds the
 * user's bearer) and snapshots it into the run's `runtimeDescriptor`
 * field (see plan v4 §C). The pump worker then reconstructs an
 * equivalent manager from that descriptor by going straight into the
 * SDK constructor — no Convex auth round-trip, no bearer, no per-job
 * `authorizeBatch` call.
 *
 * The output is intentionally equivalent (modulo OAuth refresh
 * machinery, which the worker handles via `refresh-tokens` instead of
 * the live `onUnauthorized` hook) to what `createAuthorizedManager`
 * would have built for the same `selectedServerIds`.
 */
import { MCPClientManager } from "@mcpjam/sdk";
import type { HttpServerConfig } from "@mcpjam/sdk";
import { INSPECTOR_MCP_RETRY_POLICY } from "./mcp-retry-policy.js";

/**
 * Per-server entry from the run's stored `runtimeDescriptor.perServer`.
 *
 * Mirrors backend `parseRuntimeDescriptor` (see
 * `mcpjam-backend/convex/sessionSimulation/routes.ts`). Optional fields
 * are accepted defensively — Stage 3 only requires `serverId` + `url`
 * for HTTP MCP transport, the rest are best-effort pass-through.
 */
export interface SynthesisDescriptorPerServerEntry {
  serverId: string;
  transportType?: string;
  url?: string;
  headers?: Record<string, unknown>;
  useOAuth?: boolean;
  oauthAccessToken?: string;
  oauthRefreshHandle?: string;
}

/**
 * Chatbox-level configuration the durable runner needs in order to
 * drive the chat loop without re-reading the chatbox config from
 * Convex at job-execution time. Mirrors the subset of fields the
 * in-process runner used to read off the live chatbox row.
 */
export interface SynthesisChatboxConfig {
  modelId?: string;
  modelSource?: "mcpjam" | "byok" | "local_byok";
  systemPrompt?: string;
  temperature?: number;
  requireToolApproval?: boolean;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  allowedServerIds?: string[];
  accessVersion?: number;
}

export interface SynthesisRuntimeDescriptor {
  selectedServerIds: string[];
  perServer: SynthesisDescriptorPerServerEntry[];
  /**
   * Chatbox-level policies (model, approval, visibility, system
   * prompt). The durable runner reads these directly so it doesn't
   * need a second Convex round-trip per claim.
   */
  chatboxConfig?: SynthesisChatboxConfig;
}

export interface BuildSynthesisManagerOptions {
  descriptor: SynthesisRuntimeDescriptor;
  timeoutMs: number;
}

export interface BuildSynthesisManagerResult {
  manager: MCPClientManager;
  /** Server IDs that produced a usable HttpServerConfig (subset of descriptor.selectedServerIds). */
  connectedServerIds: string[];
  /** Async cleanup, mirrors `withManager` semantics in `routes/web/auth.ts`. */
  dispose: () => Promise<void>;
}

/**
 * Normalize a descriptor entry's headers map: drop non-string values
 * and reject empty keys. Matches the defensive shape `toHttpConfig`
 * uses on `serverConfig.headers`.
 */
function normalizeHeaders(
  raw: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Translate a single descriptor entry into the SDK's `HttpServerConfig`.
 * Returns null when the entry can't be materialized into a usable HTTP
 * config (missing URL, non-http transport) — those servers are skipped
 * rather than failing the whole job, mirroring how the live path skips
 * unauthorized OAuth servers via the `oauthServerUrls` map.
 */
function descriptorEntryToHttpConfig(
  entry: SynthesisDescriptorPerServerEntry,
  timeoutMs: number,
): HttpServerConfig | null {
  if (typeof entry.url !== "string" || entry.url.length === 0) return null;
  // Only HTTP transport is supported in hosted mode (matches
  // `toHttpConfig` invariant). Stage 3 doesn't ship stdio descriptors.
  if (entry.transportType && entry.transportType !== "http") return null;

  const headers = normalizeHeaders(entry.headers);
  if (entry.useOAuth && entry.oauthAccessToken) {
    headers["Authorization"] = `Bearer ${entry.oauthAccessToken}`;
  }

  return {
    url: entry.url,
    requestInit: {
      headers,
    },
    timeout: timeoutMs,
  };
}

/**
 * Build a manager whose per-server configs match what the live
 * `createAuthorizedManager` would have produced for the same inputs.
 *
 * Equivalence boundary:
 * - Outbound URL, headers (including injected OAuth bearer): same as live.
 * - `timeout`: same as live (caller passes `WEB_STREAM_TIMEOUT_MS`).
 * - `retryPolicy`: same `INSPECTOR_MCP_RETRY_POLICY` constant.
 * - `clientInfo` / `supportedProtocolVersions` / `mcpProtocolVersion`
 *   pins from `mcpProfile.initialize.*`: NOT mirrored at Stage 3
 *   because the descriptor doesn't yet carry them. Defaults match the
 *   SDK defaults for the run. If a chatbox pins a wire mode, document
 *   the gap and fall through to SDK defaults — the run still executes,
 *   the gap is "pin not honored", not "session fails".
 *
 * @returns a {@link BuildSynthesisManagerResult} that the caller owns
 *   and is responsible for disposing once the job finishes.
 */
export function buildSynthesisManager(
  opts: BuildSynthesisManagerOptions,
): BuildSynthesisManagerResult {
  const { descriptor, timeoutMs } = opts;
  const selected = new Set(descriptor.selectedServerIds);

  const configEntries: Array<[string, HttpServerConfig]> = [];
  const connectedServerIds: string[] = [];
  for (const entry of descriptor.perServer) {
    if (!selected.has(entry.serverId)) continue;
    const config = descriptorEntryToHttpConfig(entry, timeoutMs);
    if (!config) continue;
    configEntries.push([entry.serverId, config]);
    connectedServerIds.push(entry.serverId);
  }

  const manager = new MCPClientManager(Object.fromEntries(configEntries), {
    defaultTimeout: timeoutMs,
    retryPolicy: INSPECTOR_MCP_RETRY_POLICY,
  });
  return {
    manager,
    connectedServerIds,
    dispose: async () => {
      await manager.disconnectAllServers();
    },
  };
}
