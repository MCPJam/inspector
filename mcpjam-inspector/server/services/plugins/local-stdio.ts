/**
 * Local stdio plugin components: identity → materialized bundle → spawnable
 * config (INS-6).
 *
 * A plugin's server component is an ORDINARY project server row (the pin lives
 * on the environment; hosts stay plugin-blind), so it reaches the local connect
 * path through the same `/web/authorize-batch-local` call as any stdio server.
 * What makes it a plugin component is only that its command/args/env still
 * carry the SDK's root placeholders. That is the detection signal used here —
 * no parallel plugin routing, no second resolution system.
 *
 * Plugin identity for such a server is recovered through the INS-3 attribution
 * probe, which is the backend's OWN lifecycle-enforcing resolver
 * (`plugins:resolvePluginRuntimePreview`: ready + installed + enabled +
 * same-project, re-decided per call). So a disabled or uninstalled plugin
 * stops resolving here immediately — the cache never becomes a way to keep
 * running something the backend has stopped authorizing. The cache holds
 * CONTENT, never a resolution.
 */
import type { ConvexHttpClient } from "convex/browser";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { fetchPluginRuntimeAttribution } from "../environments/plugin-attribution.js";
import {
  PluginBundleCache,
  PluginBundleCacheError,
  type PluginBundleIdentity,
} from "./bundle-cache.js";
import {
  needsPluginRoot,
  resolvePluginStdioLaunch,
  type PluginStdioLaunchSpec,
} from "./plugin-root.js";
import type { PluginFileSource } from "@mcpjam/sdk/plugin-bundle";

export { PluginBundleCache, PluginBundleCacheError };

const LIST_PLUGINS_FUNCTION_REF = "plugins:listProjectPlugins" as const;

let leaseSequence = 0;

/** Process-wide cache. One entry per immutable bundle, shared by all sessions. */
let sharedCache: PluginBundleCache | null = null;
export function getPluginBundleCache(): PluginBundleCache {
  if (!sharedCache) sharedCache = new PluginBundleCache();
  return sharedCache;
}

/** Test seam: swap the process-wide cache (used by the desktop tests). */
export function setPluginBundleCacheForTesting(
  cache: PluginBundleCache | null
): void {
  sharedCache = cache;
}

export interface PluginServerOrigin {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  /** `null` under deploy skew — a version without a hash cannot be cached. */
  bundleHash: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which pinned plugin version contributed `serverId`, or `null` when none does.
 *
 * `null` is a real answer, not a soft failure: a stdio config carrying a root
 * placeholder that no CURRENTLY resolvable plugin version claims must not be
 * launched (we would have nothing to substitute, and the placeholder would
 * reach the shell verbatim). Callers fail closed on it.
 */
export async function resolvePluginOriginForServer(
  client: ConvexHttpClient,
  args: { projectId: string; serverId: string }
): Promise<PluginServerOrigin | null> {
  const raw: unknown = await client.query(LIST_PLUGINS_FUNCTION_REF as any, {
    projectId: args.projectId,
  } as any);
  const rows = Array.isArray(raw) ? raw : [];
  const versionIds = rows
    .filter(
      (row) =>
        isRecord(row) &&
        row.enabled !== false &&
        typeof row.activeVersionId === "string"
    )
    .map((row) => (row as { activeVersionId: string }).activeVersionId);
  if (versionIds.length === 0) return null;

  const attribution = await fetchPluginRuntimeAttribution(client, {
    projectId: args.projectId,
    pluginVersionIds: versionIds,
  });
  // `null` (probe unavailable) and "no entry" are the same decision here:
  // without an attested origin there is no bundle hash to materialize against.
  const origin = attribution?.serverOrigins.get(args.serverId);
  return origin ? { ...origin } : null;
}

export type PluginStdioPreparationFailure =
  | { reason: "no_plugin_origin" }
  | { reason: "missing_bundle_hash"; origin: PluginServerOrigin }
  | {
      reason: "bundle_not_materialized" | "bundle_verification_failed";
      origin: PluginServerOrigin;
      message: string;
    };

export type PluginStdioPreparation =
  | {
      ok: true;
      origin: PluginServerOrigin;
      /** Absolute cache path the placeholders were substituted with. */
      pluginRoot: string;
      launch: ReturnType<typeof resolvePluginStdioLaunch>;
      /** Call on disconnect: releases the GC lease on the cache entry. */
      release: () => void;
    }
  | ({ ok: false } & PluginStdioPreparationFailure);

/**
 * Prepare a plugin stdio component for launch: resolve its origin, verify (or
 * seed) the cached bundle, substitute the root placeholders, and lease the
 * entry so cleanup cannot delete it mid-session.
 *
 * Returns a structured failure rather than throwing so the connect path can map
 * each case to its own actionable error; every failure mode leaves the
 * placeholders unsubstituted, i.e. nothing spawns.
 */
export async function preparePluginStdioLaunch(args: {
  client: ConvexHttpClient;
  cache: PluginBundleCache;
  projectId: string;
  serverId: string;
  spec: PluginStdioLaunchSpec;
  /** Session identity for the GC lease (typically the manager's server name). */
  leaseId: string;
  /** Just-imported bundle content, when the caller has it (desktop import). */
  source?: PluginFileSource;
}): Promise<PluginStdioPreparation> {
  const origin = await resolvePluginOriginForServer(args.client, {
    projectId: args.projectId,
    serverId: args.serverId,
  });
  if (!origin) return { ok: false, reason: "no_plugin_origin" };
  if (!origin.bundleHash) {
    return { ok: false, reason: "missing_bundle_hash", origin };
  }

  const identity: PluginBundleIdentity = {
    projectId: args.projectId,
    pluginVersionId: origin.pluginVersionId,
    bundleHash: origin.bundleHash,
  };
  let root: string;
  try {
    const materialized = await args.cache.materialize(identity, {
      source: args.source,
    });
    root = materialized.root;
  } catch (error) {
    const code =
      error instanceof PluginBundleCacheError ? error.code : "invalid_bundle";
    return {
      ok: false,
      reason:
        code === "not_cached"
          ? "bundle_not_materialized"
          : "bundle_verification_failed",
      origin,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Unique per call, not just per server: a reconnect acquires the new lease
  // BEFORE releasing the old one, and two holders sharing an id would make
  // that release drop the live lease too.
  const release = args.cache.acquire(
    identity,
    `${args.leaseId}#${++leaseSequence}`
  );
  return {
    ok: true,
    origin,
    pluginRoot: root,
    launch: resolvePluginStdioLaunch(args.spec, root),
    release,
  };
}

// ---------------------------------------------------------------------------
// Connect-path glue
// ---------------------------------------------------------------------------

/**
 * Leases held on behalf of live manager entries, keyed by the manager's server
 * name (the same key `connectToServer` / `disconnectServer` use). Re-connecting
 * a server replaces its lease; disconnecting drops it, which is what makes
 * `collectGarbage` able to reclaim an entry no session is running from.
 */
const leasesByServerName = new Map<string, () => void>();

export function releasePluginLease(serverName: string): void {
  const release = leasesByServerName.get(serverName);
  if (!release) return;
  leasesByServerName.delete(serverName);
  release();
}

function retainPluginLease(serverName: string, release: () => void): void {
  releasePluginLease(serverName);
  leasesByServerName.set(serverName, release);
}

/**
 * Resolve a local stdio server whose config still carries root placeholders
 * into a spawnable one, or throw the actionable reason it cannot run.
 *
 * Returns `null` for the overwhelmingly common case: an ordinary stdio server
 * with no placeholders, which must take exactly the historical path.
 */
export async function materializePluginStdioForConnect(args: {
  /** Built only for a component that actually carries placeholders. */
  createClient: () => ConvexHttpClient;
  projectId: string;
  serverId: string;
  /** Manager key the lease is bound to. */
  serverName: string;
  spec: PluginStdioLaunchSpec;
  cache?: PluginBundleCache;
}): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  pluginRoot: string;
  origin: PluginServerOrigin;
} | null> {
  if (!needsPluginRoot(args.spec)) return null;

  const prepared = await preparePluginStdioLaunch({
    client: args.createClient(),
    cache: args.cache ?? getPluginBundleCache(),
    projectId: args.projectId,
    serverId: args.serverId,
    spec: args.spec,
    leaseId: args.serverName,
  });

  if (!prepared.ok) {
    throw pluginStdioFailureToRouteError(args.serverName, prepared);
  }

  retainPluginLease(args.serverName, prepared.release);
  return {
    command: prepared.launch.command,
    args: prepared.launch.args,
    env: prepared.launch.env,
    pluginRoot: prepared.pluginRoot,
    origin: prepared.origin,
  };
}

/**
 * Every failure is 409, not 500: the request was well-formed and retrying it
 * verbatim will not help — the user has to import/enable the plugin or repair
 * the cache. `reason` is machine-readable so the client can offer the matching
 * remedy instead of parsing prose.
 */
function pluginStdioFailureToRouteError(
  serverName: string,
  failure: { ok: false } & PluginStdioPreparationFailure
): WebRouteError {
  switch (failure.reason) {
    case "no_plugin_origin":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Server "${serverName}" is a plugin component but no installed, enabled plugin version currently provides it. Re-enable or re-import the plugin, then reconnect.`,
        { reason: failure.reason, serverName }
      );
    case "missing_bundle_hash":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Plugin "${failure.origin.name}" reports no bundle hash, so its files cannot be verified. Re-import the plugin.`,
        { reason: failure.reason, serverName, pluginId: failure.origin.pluginId }
      );
    case "bundle_not_materialized":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Plugin "${failure.origin.name}" is not materialized on this machine. Re-import the plugin from its folder on this device to run its local component.`,
        {
          reason: failure.reason,
          serverName,
          pluginId: failure.origin.pluginId,
          bundleHash: failure.origin.bundleHash,
        }
      );
    case "bundle_verification_failed":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Cached files for plugin "${failure.origin.name}" failed hash verification and will not be launched. Re-import the plugin to restore a verified copy.`,
        {
          reason: failure.reason,
          serverName,
          pluginId: failure.origin.pluginId,
          bundleHash: failure.origin.bundleHash,
          details: failure.message,
        }
      );
  }
}

export { needsPluginRoot };
