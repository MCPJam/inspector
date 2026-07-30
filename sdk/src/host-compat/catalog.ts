import type { McpAppsCapabilities } from "../host-config/types.js";
import type { SeededHostConfigInput } from "../host-config/templates/index.js";
import { MCP_APPS_NO_CLAIMS } from "./capabilities.js";
import { BUNDLED_HOST_COMPAT_CATALOG } from "./catalog.generated.js";
import {
  evaluateAllHosts,
  type EvaluateAllHostsOptions,
  type HostCompatEvaluation,
} from "./evaluator.js";
import { hostConfigFieldsToImageSupport } from "./image-support.js";
import type { HostCompatToolsInput } from "./server-requirements.js";
import type {
  CompatProvenance,
  HostCompatProfile,
  HostImageSupport,
} from "./types.js";

export type DocumentedCapabilityEvidence = {
  status: "supported" | "unsupported" | "limited";
  mcpAppsEquivalent?: string;
  note?: string;
};

export type HostCompatibilityEvidence = {
  profileLabel: string;
  sourceUrl: string;
  sourceUpdatedAt: number;
  componentBridge: Record<string, DocumentedCapabilityEvidence>;
  toolDescriptorMeta: Record<string, DocumentedCapabilityEvidence>;
  toolAnnotations: Record<string, DocumentedCapabilityEvidence>;
  componentResourceMeta: Record<string, DocumentedCapabilityEvidence>;
  cspProperties: Record<string, DocumentedCapabilityEvidence>;
  hostProvidedToolResultMeta: Record<string, DocumentedCapabilityEvidence>;
  clientProvidedMeta: Record<string, DocumentedCapabilityEvidence>;
  deployment: {
    supportedUiStandards: string[];
    productionAuthentication: string[];
    developmentAuthentication: string[];
    widgetHostPattern: string;
    oauthRedirectUris: Array<{ surface: string; uri: string }>;
    entraSsoRedirectUris: Array<{ surface: string; uri: string }>;
    minimumAgentsToolkitVersion: string;
    defaultToolDiscovery: string;
    notes: string[];
  };
};

/**
 * The host-compat catalog facts as pure data. The live backend catalog is the
 * normal source of truth; the SDK carries a generated fallback snapshot for
 * offline/CLI/dev paths.
 */

type HostCatalogMetadata = {
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
  /** Structured vendor-document evidence that does not shape execution. */
  compatibilityEvidence?: HostCompatibilityEvidence;
};

/**
 * One catalog host. Compare/display facts and the creation config live on the
 * same object.
 */
export type HostCompatCatalogHost = HostCatalogMetadata & SeededHostConfigInput;

/**
 * The catalog document served by the backend and proxied by the inspector.
 * `hostsById` is the single source of truth for each built-in host style.
 */
export type HostCompatCatalog = {
  hostsById: Record<string, HostCompatCatalogHost>;
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
  cachedBundledCatalog ??= deepFreeze(
    hydrateHostCompatCatalog(cloneJson(BUNDLED_HOST_COMPAT_CATALOG))
  );
  return cachedBundledCatalog;
}

/**
 * Return a catalog whose `hostsById` entries are directly usable as full host
 * objects. `imageSupport` is a compare/display summary derived from the
 * concrete host-template image fields.
 */
export function hydrateHostCompatCatalog(
  catalog: HostCompatCatalog
): HostCompatCatalog {
  return {
    hostsById: Object.fromEntries(
      Object.entries(catalog.hostsById).map(([id, host]) => [
        id,
        hydrateCatalogHost(host),
      ])
    ),
  };
}

function hydrateCatalogHost(
  host: HostCompatCatalogHost
): HostCompatCatalogHost {
  const imageSupport =
    hostConfigFieldsToImageSupport(host) ?? host.imageSupport;
  return {
    ...host,
    ...(imageSupport ? { imageSupport } : undefined),
  };
}

export function getTemplateMcpAppsCapabilities(
  catalog: HostCompatCatalog,
  hostStyle: string
): McpAppsCapabilities | undefined {
  const host = getCatalogHost(catalog, hostStyle);
  const apps = host?.mcpProfile?.apps as
    | { mcpAppsOverrides?: McpAppsCapabilities }
    | undefined;
  return apps?.mcpAppsOverrides;
}

export function getCatalogHost(
  catalog: HostCompatCatalog,
  hostStyle: string
): HostCompatCatalogHost | undefined {
  const host = Object.hasOwn(catalog.hostsById, hostStyle)
    ? catalog.hostsById[hostStyle]
    : undefined;
  return host ? hydrateCatalogHost(host) : undefined;
}

export function getCatalogTemplate(
  catalog: HostCompatCatalog,
  hostStyle: string
): SeededHostConfigInput | undefined {
  const host = getCatalogHost(catalog, hostStyle);
  if (!host) return undefined;
  return cloneJson(hostConfigFromCatalogHost(host));
}

export function getCatalogHosts(
  catalog: HostCompatCatalog
): HostCompatCatalogHost[] {
  return Object.values(catalog.hostsById).map(hydrateCatalogHost);
}

function hostConfigFromCatalogHost(
  host: HostCompatCatalogHost
): SeededHostConfigInput {
  const {
    id: _id,
    label: _label,
    provenance: _provenance,
    rendersMcpApps: _rendersMcpApps,
    supportedProtocolVersions: _supportedProtocolVersions,
    verifiedAt: _verifiedAt,
    imageSupport: _imageSupport,
    compatibilityEvidence: _compatibilityEvidence,
    ...config
  } = host;
  return config;
}

function templateRendersOpenAiApps(
  host: HostCompatCatalogHost | undefined
): boolean {
  const apps = host?.mcpProfile?.apps as
    | { compatRuntime?: { openaiApps?: boolean } }
    | undefined;
  return apps?.compatRuntime?.openaiApps === true;
}

/**
 * Pull the exact sandbox permission allowlist out of a host template. Keep an
 * empty allowlist: it is an explicit host decision, not the same as absent
 * catalog data.
 */
function getTemplateSandboxPermissionAllow(
  host: HostCompatCatalogHost | undefined
): Record<string, boolean> | undefined {
  const permissions = (
    host?.mcpProfile?.apps as
      | { sandbox?: { permissions?: { allow?: unknown } } }
      | undefined
  )?.sandbox?.permissions;
  const allow = permissions?.allow;
  if (!allow || typeof allow !== "object" || Array.isArray(allow)) {
    return undefined;
  }
  const entries = Object.entries(allow).filter(
    ([, value]) => typeof value === "boolean"
  );
  return Object.fromEntries(entries);
}

/** Fresh copy of a profile (incl. its nested arrays) so callers can't mutate
 * the cache or the shared capability-matrix constants. */
function cloneProfile(p: HostCompatProfile): HostCompatProfile {
  return {
    ...p,
    verifiedAt: p.verifiedAt,
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
    sandboxPermissionAllow: p.sandboxPermissionAllow
      ? { ...p.sandboxPermissionAllow }
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
 *  - `rendersOpenAiApps` comes from the host object's
 *    `mcpProfile.apps.compatRuntime.openaiApps`.
 *  - `rendersWidgets = rendersMcpApps || rendersOpenAiApps`; the capability
 *    matrix applies only when the host renders widgets at all, reading the
 *    matrix from `hostsById[id].mcpProfile.apps.mcpAppsOverrides` and
 *    defaulting to `MCP_APPS_NO_CLAIMS` when the template carries no matrix.
 *
 * Does not mutate or freeze the input catalog.
 */
export function buildHostProfilesFromCatalog(
  catalog: HostCompatCatalog
): HostCompatProfile[] {
  return Object.entries(catalog.hostsById)
    .map(([id, host]) => {
      const rendersOpenAiApps = templateRendersOpenAiApps(host);
      const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
      const templateCapabilities = getTemplateMcpAppsCapabilities(catalog, id);
      const capabilities = rendersWidgets
        ? templateCapabilities ?? MCP_APPS_NO_CLAIMS
        : undefined;
      return {
        id: host.id,
        label: host.label,
        provenance: host.provenance,
        verifiedAt: host.verifiedAt,
        rendersMcpApps: host.rendersMcpApps,
        rendersOpenAiApps,
        supportedProtocolVersions: host.supportedProtocolVersions,
        capabilities,
        sandboxPermissionAllow: getTemplateSandboxPermissionAllow(host),
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
