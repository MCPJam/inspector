import type { McpAppsCapabilities } from "../host-config/types.js";
import type { SeededHostConfigInput } from "../host-config/templates/index.js";
import { MCP_APPS_NO_CLAIMS } from "./capabilities.js";
import { BUNDLED_HOST_COMPAT_CATALOG } from "./catalog.generated.js";
import {
  evaluateAllHosts,
  type EvaluateAllHostsOptions,
  type HostCompatEvaluation,
} from "./evaluator.js";
import type { HostCompatToolsInput } from "./server-requirements.js";
import type {
  CompatProvenance,
  HostCompatProfile,
  HostImageSupport,
} from "./types.js";

/**
 * The host-compat catalog facts as pure data. The live backend catalog is the
 * normal source of truth; the SDK carries a generated fallback snapshot for
 * offline/CLI/dev paths.
 */

/**
 * A market host's catalog facts. `id` is a plain string in fetched catalogs —
 * new hosts must not require an SDK release; the bundled generated snapshot is
 * only an offline fallback.
 */
export type HostCompatCatalogHost = {
  id: string;
  label: string;
  provenance: CompatProvenance;
  rendersMcpApps: boolean;
  /**
   * MCP base-protocol versions this host advertises. Omitted when the template
   * doesn't pin a version.
   */
  supportedProtocolVersions?: string[];
  /** When this host's facts were last verified (ms epoch). */
  verifiedAt?: number;
  /** Tool-result image handling (see `HostImageSupport`). */
  imageSupport?: HostImageSupport;
};

/**
 * The catalog document served by the backend and proxied by the inspector.
 * `templatesById` contains full host creation templates for all built-in host
 * styles, including non-market hosts such as `mcpjam` and `claude-code`.
 */
export type HostCompatCatalog = {
  marketHosts: HostCompatCatalogHost[];
  openAiCompatByStyle: Record<string, boolean>;
  templatesById: Record<string, SeededHostConfigInput>;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Recursively freeze a value in place. The catalog module's invariant: shared
 * catalog/profile source data is frozen; anything handed to a caller for
 * mutation should be copied first.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

let cachedBundledCatalog: HostCompatCatalog | null = null;

/**
 * The SDK's bundled fallback catalog. Generated from the backend seed during
 * release/build workflow; stale between releases by design. Deep-frozen and
 * shared so consumers cannot accidentally mutate process-wide fallback facts.
 */
export function bundledHostCompatCatalog(): HostCompatCatalog {
  cachedBundledCatalog ??= deepFreeze(cloneJson(BUNDLED_HOST_COMPAT_CATALOG));
  return cachedBundledCatalog;
}

export function getTemplateMcpAppsCapabilities(
  catalog: HostCompatCatalog,
  hostStyle: string
): McpAppsCapabilities | undefined {
  const template = Object.hasOwn(catalog.templatesById, hostStyle)
    ? catalog.templatesById[hostStyle]
    : undefined;
  const apps = template?.mcpProfile?.apps as
    | { mcpAppsOverrides?: McpAppsCapabilities }
    | undefined;
  if (apps?.mcpAppsOverrides !== undefined) return apps.mcpAppsOverrides;
  return legacyHostCapabilitiesOverrideToMcpAppsCapabilities(
    template?.hostCapabilitiesOverride
  );
}

function legacyHostCapabilitiesOverrideToMcpAppsCapabilities(
  legacy: Record<string, unknown> | undefined
): McpAppsCapabilities | undefined {
  if (legacy === undefined) return undefined;
  return {
    openLinks: legacy.openLinks !== undefined,
    serverTools: legacy.serverTools !== undefined,
    serverResources: legacy.serverResources !== undefined,
    logging: legacy.logging !== undefined,
    updateModelContext: legacy.updateModelContext !== undefined,
    message: legacy.message !== undefined,
    downloadFile: legacy.downloadFile !== undefined,
  };
}

/** Fresh copy of a profile (incl. its nested arrays) so callers can't mutate
 * the cache or the shared capability-matrix constants. */
function cloneProfile(p: HostCompatProfile): HostCompatProfile {
  return {
    ...p,
    supportedProtocolVersions: p.supportedProtocolVersions
      ? [...p.supportedProtocolVersions]
      : undefined,
    capabilities: p.capabilities
      ? {
          ...p.capabilities,
          availableDisplayModes: p.capabilities.availableDisplayModes
            ? [...p.capabilities.availableDisplayModes]
            : undefined,
        }
      : undefined,
    imageSupport: p.imageSupport
      ? {
          toolImageContent: { ...p.imageSupport.toolImageContent },
          embeddedResourceImages: { ...p.imageSupport.embeddedResourceImages },
          resourceLinkImages: { ...p.imageSupport.resourceLinkImages },
          placement: p.imageSupport.placement,
        }
      : undefined,
  };
}

/**
 * Build host-compat profiles from a catalog document — the derivation half of
 * the data/engine split. Load-bearing semantics:
 *
 *  - `rendersOpenAiApps = openAiCompatByStyle[id] === true` — independent of
 *    `rendersMcpApps`.
 *  - `rendersWidgets = rendersMcpApps || rendersOpenAiApps`; the capability
 *    matrix applies only when the host renders widgets at all, reading the
 *    matrix from `templatesById[id].mcpProfile.apps.mcpAppsOverrides` and
 *    defaulting to `MCP_APPS_NO_CLAIMS` when the template carries no matrix.
 *
 * Does not mutate or freeze the input catalog.
 */
export function buildHostProfilesFromCatalog(
  catalog: HostCompatCatalog
): HostCompatProfile[] {
  return catalog.marketHosts
    .map((host) => {
      // Own-property checks throughout: host ids are arbitrary strings in a
      // fetched catalog and can collide with Object.prototype keys.
      const rendersOpenAiApps =
        Object.hasOwn(catalog.openAiCompatByStyle, host.id) &&
        catalog.openAiCompatByStyle[host.id] === true;
      const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
      const templateCapabilities = getTemplateMcpAppsCapabilities(
        catalog,
        host.id
      );
      const capabilities = rendersWidgets
        ? templateCapabilities ?? MCP_APPS_NO_CLAIMS
        : undefined;
      return {
        id: host.id,
        label: host.label,
        provenance: host.provenance,
        rendersMcpApps: host.rendersMcpApps,
        rendersOpenAiApps,
        supportedProtocolVersions: host.supportedProtocolVersions,
        capabilities,
        imageSupport: host.imageSupport,
      };
    })
    .map(cloneProfile);
}

let cachedProfiles: readonly HostCompatProfile[] | null = null;

/**
 * Build the market-host compat profiles from the bundled fallback catalog.
 * The build runs once (cached); each call returns fresh copies so a caller
 * sorting the array or tweaking a profile can't change later evaluations.
 */
export function buildMarketHostProfiles(): HostCompatProfile[] {
  cachedProfiles ??= buildHostProfilesFromCatalog(bundledHostCompatCatalog());
  return cachedProfiles.map(cloneProfile);
}

export interface EvaluateMarketHostsOptions extends EvaluateAllHostsOptions {
  /**
   * A live-fetched catalog to evaluate against instead of the bundled fallback.
   */
  catalog?: HostCompatCatalog;
}

/**
 * Convenience: evaluate a server against the market-host catalog. Pass
 * `options.catalog` to use a live-fetched backend catalog.
 */
export function evaluateMarketHosts(
  toolsData: HostCompatToolsInput | null | undefined,
  options?: EvaluateMarketHostsOptions
): HostCompatEvaluation {
  const { catalog, ...evaluateOptions } = options ?? {};
  const profiles = catalog
    ? buildHostProfilesFromCatalog(catalog)
    : buildMarketHostProfiles();
  return evaluateAllHosts(toolsData, profiles, evaluateOptions);
}
