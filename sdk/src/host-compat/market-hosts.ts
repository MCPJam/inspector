import type { McpAppsCapabilities } from "../host-config/types.js";
import { compatPresetForHostStyle } from "../host-config/compat-runtime.js";
import {
  seedHostTemplate,
  type HostTemplateId,
} from "../host-config/templates/seed-host-template.js";
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
};

const MARKET_HOSTS: readonly MarketHost[] = [
  { id: "claude", label: "Claude", provenance: "assumed", rendersMcpApps: true },
  { id: "chatgpt", label: "ChatGPT", provenance: "vendor-doc", rendersMcpApps: true },
  { id: "mistral", label: "Mistral", provenance: "probe", rendersMcpApps: true },
  { id: "goose", label: "Goose", provenance: "probe", rendersMcpApps: true },
  { id: "cursor", label: "Cursor", provenance: "probe", rendersMcpApps: true },
  { id: "copilot", label: "Copilot", provenance: "vendor-doc", rendersMcpApps: true },
  { id: "codex", label: "Codex", provenance: "assumed", rendersMcpApps: false },
  { id: "n8n", label: "n8n", provenance: "probe", rendersMcpApps: false },
  { id: "perplexity", label: "Perplexity", provenance: "probe", rendersMcpApps: false },
  { id: "cline", label: "Cline", provenance: "probe", rendersMcpApps: false },
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

// Seeding a template builds a full config, so cache the protocol-version read
// per id (templates are static).
const protocolVersionCache = new Map<HostTemplateId, string[] | undefined>();
function supportedProtocolVersionsFor(
  id: HostTemplateId,
): string[] | undefined {
  if (!protocolVersionCache.has(id)) {
    const seeded = seedHostTemplate(id);
    // `SeededHostConfigInput` types `initialize` loosely; the runtime value
    // carries `supportedProtocolVersions` (the templates set it).
    const initialize = seeded.mcpProfile?.initialize as
      | { supportedProtocolVersions?: string[] }
      | undefined;
    protocolVersionCache.set(id, initialize?.supportedProtocolVersions);
  }
  return protocolVersionCache.get(id);
}

let cachedProfiles: HostCompatProfile[] | null = null;

/**
 * Build the market-host compat profiles — the default host catalog. Joins the
 * market-host facts with `rendersOpenAiApps` (the SDK's OpenAI-compat preset),
 * the host template's advertised protocol versions, and the capability matrix
 * (only when the host renders widgets at all — a headless host leaves it
 * undefined). Static, so built once.
 */
export function buildMarketHostProfiles(): HostCompatProfile[] {
  if (cachedProfiles) return cachedProfiles;
  cachedProfiles = MARKET_HOSTS.map((host) => {
    const rendersOpenAiApps = compatPresetForHostStyle(host.id) === true;
    const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
    return {
      id: host.id,
      label: host.label,
      provenance: host.provenance,
      rendersMcpApps: host.rendersMcpApps,
      rendersOpenAiApps,
      supportedProtocolVersions: supportedProtocolVersionsFor(host.id),
      capabilities: rendersWidgets
        ? (MATRIX_BY_ID[host.id] ?? MCP_APPS_NO_CLAIMS)
        : undefined,
    };
  });
  return cachedProfiles;
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
