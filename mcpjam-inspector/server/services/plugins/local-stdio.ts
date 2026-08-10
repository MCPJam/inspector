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
import { ensurePluginDataDir } from "./plugin-data.js";
import {
  containsPluginPlaceholder,
  type PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import { createZipPluginFileSource } from "./bundle-file-sources.js";
import { MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES } from "../../../shared/plugin-bundle-limits.js";

export { PluginBundleCache, PluginBundleCacheError };

const LIST_PLUGINS_FUNCTION_REF = "plugins:listProjectPlugins" as const;
const BUNDLE_DOWNLOAD_FUNCTION_REF = "plugins:getBundleDownloadUrl" as const;

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

/**
 * Fetch a version's bundle bytes from the backend's authorized read
 * (`plugins:getBundleDownloadUrl`, Phase 0.4) as a parseable source.
 *
 * Every failure returns `null` rather than throwing: a backend without the
 * endpoint yet, revoked access, a network error, an over-cap body, or a
 * non-archive response all fall back to the historical "re-import on this
 * device" remedy. Integrity is NOT judged here — the verified cache
 * re-hashes whatever this returns against the pinned bundleHash.
 */
async function downloadBundleSource(
  client: ConvexHttpClient,
  pluginVersionId: string
): Promise<PluginFileSource | null> {
  let url: string;
  try {
    const raw: unknown = await client.query(
      BUNDLE_DOWNLOAD_FUNCTION_REF as any,
      { pluginVersionId } as any
    );
    if (!isRecord(raw) || typeof raw.url !== "string" || raw.url.length === 0) {
      return null;
    }
    url = raw.url;
  } catch {
    return null;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES) return null;
    return await createZipPluginFileSource(new Uint8Array(buffer));
  } catch {
    return null;
  }
}

export type PluginStdioPreparationFailure =
  | { reason: "no_plugin_origin" }
  | { reason: "missing_bundle_hash"; origin: PluginServerOrigin }
  | {
      reason: "bundle_not_materialized" | "bundle_verification_failed";
      origin: PluginServerOrigin;
      message: string;
    }
  | {
      /**
       * A placeholder-shaped token survived substitution — a future spec
       * placeholder this build does not implement. Fail closed: a child
       * process must never see a placeholder verbatim. `placeholder` is the
       * bare token only — never the containing value, which may embed
       * expanded paths or adjacent secrets.
       */
      reason: "unsupported_placeholder";
      origin: PluginServerOrigin;
      placeholder: string;
    }
  | {
      /**
       * The writable `${PLUGIN_DATA}` directory could not be created — a
       * LOCAL filesystem problem (unwritable `~/.mcpjam`, full disk,
       * permissions), never a bundle problem: re-importing cannot fix it.
       */
      reason: "plugin_data_unavailable";
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
  /** Test seam for the `${PLUGIN_DATA}` root; defaults to `~/.mcpjam/plugin-data`. */
  dataRoot?: string;
}): Promise<PluginStdioPreparation> {
  const origin = await resolvePluginOriginForServer(args.client, {
    projectId: args.projectId,
    serverId: args.serverId,
  });
  if (!origin) return { ok: false, reason: "no_plugin_origin" };
  if (!origin.bundleHash) {
    return { ok: false, reason: "missing_bundle_hash", origin };
  }

  // A placeholder the bundle declared that this build does not implement
  // must not spawn — the literal would reach the child as an argv/env/cwd
  // value. The scan runs on the ORIGINAL spec, never the resolved launch:
  // the machine's own root/data paths may legitimately contain
  // placeholder-shaped text, and substitution deliberately never re-scans
  // inserted values — re-checking resolved output would refuse exactly the
  // paths the single-pass substitution promises to preserve. The GENERIC
  // token shape (minus the implemented set) is what makes this
  // future-proof: `${PLUGIN_CACHE}` from a spec revision we haven't
  // shipped trips it today. Only the bare token is reported — the
  // containing value may embed an adjacent secret.
  const implementedTokens = new Set(["${PLUGIN_ROOT}", "${PLUGIN_DATA}"]);
  const specValues = [
    args.spec.command,
    ...args.spec.args,
    ...Object.values(args.spec.env),
    ...(args.spec.workingDirectory !== undefined
      ? [args.spec.workingDirectory]
      : []),
  ];
  for (const value of specValues) {
    for (const match of value.matchAll(/\$\{PLUGIN_[A-Z0-9_]+\}/g)) {
      if (!implementedTokens.has(match[0])) {
        return {
          ok: false,
          reason: "unsupported_placeholder",
          origin,
          placeholder: match[0],
        };
      }
    }
  }

  // The writable per-plugin data directory (spec: created before launch,
  // preserved across updates — keyed by pluginId, NOT bundleHash, so a
  // version activation keeps the component's state). Created BEFORE the
  // bundle materializes: this await must not sit between materialization
  // and the lease acquisition below, where a concurrent GC sweep could
  // reclaim the just-verified entry. Creation failure is a launch failure
  // with its own reason — a filesystem problem, not a bundle problem.
  let dataDir: string;
  try {
    dataDir = await ensurePluginDataDir({
      projectId: args.projectId,
      pluginId: origin.pluginId,
      ...(args.dataRoot !== undefined ? { rootDir: args.dataRoot } : {}),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "plugin_data_unavailable",
      origin,
      message: error instanceof Error ? error.message : String(error),
    };
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
    if (code !== "not_cached" || args.source !== undefined) {
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
    // Cache miss with no caller-supplied content: fetch the backend's stored
    // bundle (the version's own bytes, re-stored at commit). The cache
    // re-parses the download through the SDK parser and compares the
    // computed hash against the pinned `bundleHash`, so the URL grants
    // CONTENT, never trust — wrong bytes surface as verification failures
    // below and never materialize.
    const downloaded = await downloadBundleSource(
      args.client,
      origin.pluginVersionId
    );
    if (downloaded === null) {
      return {
        ok: false,
        reason: "bundle_not_materialized",
        origin,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const materialized = await args.cache.materialize(identity, {
        source: downloaded,
      });
      root = materialized.root;
    } catch (retryError) {
      return {
        ok: false,
        reason: "bundle_verification_failed",
        origin,
        message:
          retryError instanceof Error ? retryError.message : String(retryError),
      };
    }
  }

  const launch = resolvePluginStdioLaunch(args.spec, root, { dataDir });

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
    launch,
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
  /**
   * Human label for error messages when the manager key isn't one (web-route
   * managers key by serverId). Defaults to `serverName`.
   */
  displayName?: string;
  spec: PluginStdioLaunchSpec;
  cache?: PluginBundleCache;
  /** Test seam for the `${PLUGIN_DATA}` root. */
  dataRoot?: string;
}): Promise<{
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Substituted working directory, when the component declared one. */
  workingDirectory?: string;
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
    ...(args.dataRoot !== undefined ? { dataRoot: args.dataRoot } : {}),
  });

  if (!prepared.ok) {
    throw pluginStdioFailureToRouteError(
      args.displayName ?? args.serverName,
      prepared
    );
  }

  retainPluginLease(args.serverName, prepared.release);
  return {
    command: prepared.launch.command,
    args: prepared.launch.args,
    env: prepared.launch.env,
    ...(prepared.launch.workingDirectory !== undefined
      ? { workingDirectory: prepared.launch.workingDirectory }
      : {}),
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
        `Plugin "${failure.origin.name}" is not materialized on this machine and its bundle could not be downloaded from MCPJam. Re-import the plugin from its folder on this device to run its local component.`,
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
    case "unsupported_placeholder":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Plugin "${failure.origin.name}" uses ${failure.placeholder}, which this MCPJam version does not provide, so the component will not be launched. Update MCPJam to run it.`,
        {
          reason: failure.reason,
          serverName,
          pluginId: failure.origin.pluginId,
          placeholder: failure.placeholder,
        }
      );
    case "plugin_data_unavailable":
      return new WebRouteError(
        409,
        ErrorCode.CONFLICT,
        `Plugin "${failure.origin.name}" needs its data directory, but it could not be created on this machine. Check that ~/.mcpjam is writable and has free space.`,
        {
          reason: failure.reason,
          serverName,
          pluginId: failure.origin.pluginId,
          details: failure.message,
        }
      );
  }
}

export { needsPluginRoot };
