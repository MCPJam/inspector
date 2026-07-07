import type { McpAppsCapabilities } from "../host-config/types.js";
import { OPENAI_COMPAT_PRESET_BY_STYLE } from "../host-config/compat-runtime.js";
// Type-only — keeps the bundled market-host ids checked against real host
// templates without pulling the (heavy) template-seeding machinery into this
// entry's bundle. Protocol versions are stored directly below (see
// MARKET_HOSTS).
import type { HostTemplateId } from "../host-config/templates/seed-host-template.js";
import {
  MCP_APPS_FULL,
  MCP_APPS_CHATGPT,
  MCP_APPS_MISTRAL,
  MCP_APPS_CURSOR,
  MCP_APPS_GOOSE,
  MCP_APPS_COPILOT,
  MCP_APPS_NO_CLAIMS,
} from "./capabilities.js";
import {
  evaluateAllHosts,
  type EvaluateAllHostsOptions,
  type HostCompatEvaluation,
} from "./evaluator.js";
import type { HostCompatToolsInput } from "./server-requirements.js";
import type { CompatProvenance, HostCompatProfile } from "./types.js";

/**
 * The host-compat *catalog* — the market-host facts as pure data, separated
 * from the derivation/evaluation engine so the facts can live in the backend
 * (versioned, publishable without an SDK release) while this module keeps a
 * bundled copy as the offline/OSS fallback.
 *
 * LOCKSTEP: `bundledHostCompatCatalog()` must stay equal to the backend seed
 * (`convex/marketHostCatalog/seed.ts` in mcpjam-backend). Any change to
 * MARKET_HOSTS, the capability matrices, or the OpenAI-compat presets needs a
 * matching backend publish, and vice versa.
 */

/**
 * A market host's catalog facts. `id` is a plain string in fetched catalogs —
 * new hosts must not require an SDK release; the bundled list below stays
 * narrowed to `HostTemplateId` so it can't drift from the real templates.
 */
export type HostCompatCatalogHost = {
  id: string;
  label: string;
  provenance: CompatProvenance;
  rendersMcpApps: boolean;
  /**
   * MCP base-protocol versions this host advertises. Mirrors the host
   * template's `mcpProfile.initialize.supportedProtocolVersions` — stored
   * directly so this catalog doesn't import the template-seeding machinery.
   * Omitted when the template doesn't pin a version (the server-lane protocol
   * check is then skipped). Keep in sync if a template's versions change.
   */
  supportedProtocolVersions?: string[];
  /** When this host's facts were last verified (ms epoch). Backend-published
   * catalogs may carry it; the bundled catalog omits it. */
  verifiedAt?: number;
};

/**
 * The catalog document — pure JSON, exactly what the backend stores and the
 * public endpoint serves. `capabilitiesById` carries a matrix only for hosts
 * that render MCP Apps; `openAiCompatByStyle` is the OpenAI-compat preset map
 * (see `OPENAI_COMPAT_PRESET_BY_STYLE`).
 */
export type HostCompatCatalog = {
  marketHosts: HostCompatCatalogHost[];
  capabilitiesById: Record<string, McpAppsCapabilities>;
  openAiCompatByStyle: Record<string, boolean>;
};

/**
 * The "market view" host list — the real shipping targets a developer asks
 * "where can I ship this?" about. MCPJam is omitted (compatible by
 * construction). Logo-free: surfaces join presentation by `id`.
 *
 * `rendersMcpApps` is the explicit "is it headless?" fact — CLI/automation
 * hosts (Codex, n8n, Perplexity, Cline) carry capability matrices for
 * protocol-bucket reasons but have no rendering surface. `rendersOpenAiApps`
 * and the capability matrix are resolved in `buildHostProfilesFromCatalog`.
 *
 * Provenance: probe = captured from a real host; vendor-doc = published vendor
 * table; assumed = best-effort preset, unverified.
 */
const MARKET_HOSTS: readonly (HostCompatCatalogHost & {
  id: HostTemplateId;
})[] = [
  { id: "claude", label: "Claude", provenance: "assumed", rendersMcpApps: true },
  { id: "chatgpt", label: "ChatGPT", provenance: "vendor-doc", rendersMcpApps: true },
  { id: "mistral", label: "Mistral", provenance: "probe", rendersMcpApps: true, supportedProtocolVersions: ["2025-11-25"] },
  { id: "goose", label: "Goose", provenance: "probe", rendersMcpApps: true, supportedProtocolVersions: ["2025-03-26"] },
  { id: "cursor", label: "Cursor", provenance: "probe", rendersMcpApps: true },
  { id: "copilot", label: "Copilot", provenance: "vendor-doc", rendersMcpApps: true },
  { id: "codex", label: "Codex", provenance: "assumed", rendersMcpApps: false, supportedProtocolVersions: ["2025-06-18"] },
  { id: "n8n", label: "n8n", provenance: "probe", rendersMcpApps: false, supportedProtocolVersions: ["2025-11-25"] },
  { id: "perplexity", label: "Perplexity", provenance: "probe", rendersMcpApps: false, supportedProtocolVersions: ["2025-06-18"] },
  { id: "cline", label: "Cline", provenance: "probe", rendersMcpApps: false, supportedProtocolVersions: ["2025-11-25"] },
];

/** Per-host MCP Apps capability matrix (only the rendering hosts need one). */
const MATRIX_BY_ID: Partial<Record<HostTemplateId, McpAppsCapabilities>> = {
  claude: MCP_APPS_FULL,
  chatgpt: MCP_APPS_CHATGPT,
  mistral: MCP_APPS_MISTRAL,
  goose: MCP_APPS_GOOSE,
  cursor: MCP_APPS_CURSOR,
  copilot: MCP_APPS_COPILOT,
};

/**
 * Recursively freeze a value in place. The catalog module's invariant: shared
 * catalog/profile source data is frozen; anything handed to a caller is a
 * fresh copy (`cloneProfile`). Freezing fetched catalogs means a consumer
 * mutating one can't poison verdicts process-wide.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

let cachedBundledCatalog: HostCompatCatalog | null = null;

/**
 * The bundled host-compat catalog — the SDK's copy of the backend catalog
 * document, built from the same constants that always shipped in this package
 * (no codegen). Serves as the offline/OSS fallback when the live catalog
 * can't be fetched. Deep-frozen and shared; copy before editing.
 */
export function bundledHostCompatCatalog(): HostCompatCatalog {
  if (!cachedBundledCatalog) {
    const capabilitiesById: Record<string, McpAppsCapabilities> = {};
    for (const [id, matrix] of Object.entries(MATRIX_BY_ID)) {
      // Fresh copies so freezing the catalog never freezes (or aliases) the
      // exported MCP_APPS_* constants' identity in consumer equality checks.
      capabilitiesById[id] = {
        ...matrix,
        availableDisplayModes: matrix.availableDisplayModes
          ? [...matrix.availableDisplayModes]
          : undefined,
      };
    }
    cachedBundledCatalog = deepFreeze({
      marketHosts: MARKET_HOSTS.map((host) => ({
        ...host,
        supportedProtocolVersions: host.supportedProtocolVersions
          ? [...host.supportedProtocolVersions]
          : undefined,
      })),
      capabilitiesById,
      openAiCompatByStyle: { ...OPENAI_COMPAT_PRESET_BY_STYLE },
    });
  }
  return cachedBundledCatalog;
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
  };
}

/**
 * Build host-compat profiles from a catalog document — the derivation half of
 * the data/engine split. Load-bearing semantics (do not "simplify"):
 *
 *  - `rendersOpenAiApps = openAiCompatByStyle[id] === true` — independent of
 *    `rendersMcpApps` (NOT `&&`-gated).
 *  - `rendersWidgets = rendersMcpApps || rendersOpenAiApps`; the capability
 *    matrix applies only when the host renders widgets at all (a headless
 *    host leaves it undefined), defaulting to `MCP_APPS_NO_CLAIMS` when the
 *    catalog carries no matrix for a rendering host.
 *
 * The catalog is deep-frozen in place (module invariant: shared state frozen,
 * copies on the way out); each call returns fresh profile copies.
 */
export function buildHostProfilesFromCatalog(
  catalog: HostCompatCatalog,
): HostCompatProfile[] {
  deepFreeze(catalog);
  return catalog.marketHosts
    .map((host) => {
      const rendersOpenAiApps =
        catalog.openAiCompatByStyle[host.id] === true;
      const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
      return {
        id: host.id,
        label: host.label,
        provenance: host.provenance,
        rendersMcpApps: host.rendersMcpApps,
        rendersOpenAiApps,
        supportedProtocolVersions: host.supportedProtocolVersions,
        capabilities: rendersWidgets
          ? (catalog.capabilitiesById[host.id] ?? MCP_APPS_NO_CLAIMS)
          : undefined,
      };
    })
    .map(cloneProfile);
}

let cachedProfiles: readonly HostCompatProfile[] | null = null;

/**
 * Build the market-host compat profiles — the default (bundled) host catalog.
 * The build runs once (cached); each call returns fresh copies so a caller
 * sorting the array or tweaking a profile can't change later evaluations.
 */
export function buildMarketHostProfiles(): HostCompatProfile[] {
  cachedProfiles ??= buildHostProfilesFromCatalog(bundledHostCompatCatalog());
  return cachedProfiles.map(cloneProfile);
}

export interface EvaluateMarketHostsOptions extends EvaluateAllHostsOptions {
  /**
   * A (typically live-fetched) catalog to evaluate against instead of the
   * bundled one — see `fetchHostCompatCatalog`. Omitted = bundled fallback.
   */
  catalog?: HostCompatCatalog;
}

/**
 * Convenience: evaluate a server against the market-host catalog. The
 * inspector, CLI, and API can all call this instead of supplying their own
 * profiles. Pass `options.catalog` to use a live-fetched catalog.
 */
export function evaluateMarketHosts(
  toolsData: HostCompatToolsInput | null | undefined,
  options?: EvaluateMarketHostsOptions,
): HostCompatEvaluation {
  const { catalog, ...evaluateOptions } = options ?? {};
  const profiles = catalog
    ? buildHostProfilesFromCatalog(catalog)
    : buildMarketHostProfiles();
  return evaluateAllHosts(toolsData, profiles, evaluateOptions);
}
