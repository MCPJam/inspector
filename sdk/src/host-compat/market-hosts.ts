import type { McpAppsCapabilities } from "../host-config/types.js";
import { compatPresetForHostStyle } from "../host-config/compat-runtime.js";
// Type-only — keeps the market-host ids checked against real host templates
// without pulling the (heavy) template-seeding machinery into this entry's
// bundle. Protocol versions are stored directly below (see MARKET_HOSTS).
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
 * The "market view" host list — the real shipping targets a developer asks
 * "where can I ship this?" about. MCPJam is omitted (compatible by
 * construction). Logo-free: surfaces join presentation by `id`.
 *
 * `rendersMcpApps` is the explicit "is it headless?" fact — CLI/automation
 * hosts (Codex, n8n, Perplexity, Cline) carry capability matrices for
 * protocol-bucket reasons but have no rendering surface. `rendersOpenAiApps`
 * and the capability matrix are resolved below.
 *
 * Provenance: probe = captured from a real host; vendor-doc = published vendor
 * table; assumed = best-effort preset, unverified.
 */
type MarketHost = {
  id: HostTemplateId;
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
};

const MARKET_HOSTS: readonly MarketHost[] = [
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

let cachedProfiles: readonly HostCompatProfile[] | null = null;

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
 * Build the market-host compat profiles — the default host catalog. Joins the
 * market-host facts with `rendersOpenAiApps` (the SDK's OpenAI-compat preset),
 * the host template's advertised protocol versions, and the capability matrix
 * (only when the host renders widgets at all — a headless host leaves it
 * undefined). The build runs once (cached); each call returns fresh copies so a
 * caller sorting the array or tweaking a profile can't change later evaluations.
 */
export function buildMarketHostProfiles(): HostCompatProfile[] {
  if (!cachedProfiles) {
    cachedProfiles = MARKET_HOSTS.map((host) => {
      const rendersOpenAiApps = compatPresetForHostStyle(host.id) === true;
      const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
      return {
        id: host.id,
        label: host.label,
        provenance: host.provenance,
        rendersMcpApps: host.rendersMcpApps,
        rendersOpenAiApps,
        supportedProtocolVersions: host.supportedProtocolVersions,
        capabilities: rendersWidgets
          ? (MATRIX_BY_ID[host.id] ?? MCP_APPS_NO_CLAIMS)
          : undefined,
      };
    });
  }
  return cachedProfiles.map(cloneProfile);
}

/**
 * Convenience: evaluate a server against the default market-host catalog. The
 * inspector, CLI, and API can all call this instead of supplying their own
 * profiles.
 */
export function evaluateMarketHosts(
  toolsData: HostCompatToolsInput | null | undefined,
  options?: EvaluateAllHostsOptions,
): HostCompatEvaluation {
  return evaluateAllHosts(toolsData, buildMarketHostProfiles(), options);
}
