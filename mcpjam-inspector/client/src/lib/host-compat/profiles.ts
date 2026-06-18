import {
  findHostStyle,
  getCompatRuntimeForStyle,
} from "@/lib/client-styles/registry";
import type { CompatProvenance, HostCompatProfile } from "./types";

/**
 * The "market view" host list — the real shipping targets a developer asks
 * "where can I ship this?" about. MCPJam is omitted (compatible by
 * construction — it's the surface you're already on).
 *
 * Each entry carries the facts the registry can't give us:
 *   - identity (label/logo) and `provenance` (how much to trust the matrix).
 *   - `rendersMcpApps`: does this host render MCP Apps (`ui://`) widgets at
 *     all? Headless clients such as Codex, n8n, and Perplexity carry
 *     capability matrices for protocol-bucket reasons but have no rendering
 *     surface. That "is it headless?" fact isn't in the registry, so it's
 *     explicit here.
 *     (ChatGPT/Copilot render BOTH MCP Apps and the OpenAI bridge —
 *     `rendersOpenAiApps` is resolved separately below.)
 *
 * The granular *capabilities* (which widget features each host supports —
 * serverResources, message, sandbox, …) still come live from the registry,
 * so the report never drifts from the playground's emulation.
 *
 * Provenance: probe = captured from a real host (Cursor 3.4.17);
 * vendor-doc = published vendor table (Copilot; ChatGPT's OpenAI surface);
 * assumed = best-effort preset, unverified.
 */
type MarketHost = {
  id: string;
  label: string;
  logoSrc: string;
  provenance: CompatProvenance;
  rendersMcpApps: boolean;
};

const MARKET_HOSTS: readonly MarketHost[] = [
  {
    id: "claude",
    label: "Claude",
    logoSrc: "/claude_logo.png",
    provenance: "assumed",
    rendersMcpApps: true,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    logoSrc: "/openai_logo.png",
    provenance: "vendor-doc",
    rendersMcpApps: true,
  },
  // Le Chat renders MCP Apps (via `ui/initialize`) and the normalized
  // template advertises the standard MCP UI extension for that surface.
  // Captured from a probe.
  {
    id: "mistral",
    label: "Mistral",
    logoSrc: "/mistral_logo.png",
    provenance: "probe",
    rendersMcpApps: true,
  },
  {
    id: "cursor",
    label: "Cursor",
    logoSrc: "/cursor_logo.png",
    provenance: "probe",
    rendersMcpApps: true,
  },
  {
    id: "copilot",
    label: "Copilot",
    logoSrc: "/copilot_logo.png",
    provenance: "vendor-doc",
    rendersMcpApps: true,
  },
  // Codex is a CLI — it renders no widgets, of either flavor.
  {
    id: "codex",
    label: "Codex",
    logoSrc: "/codex-logo.svg",
    provenance: "assumed",
    rendersMcpApps: false,
  },
  {
    id: "n8n",
    label: "n8n",
    logoSrc: "/n8n_logo.svg",
    provenance: "probe",
    rendersMcpApps: false,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    logoSrc: "/perplexity_logo.svg",
    provenance: "probe",
    rendersMcpApps: false,
  },
];

/**
 * Build the compat profiles by joining the market-host facts with the
 * registry's live capability matrix. `rendersOpenAiApps` is the one render
 * flag the registry CAN give us cleanly (the `window.openai` shim toggle),
 * so it stays derived; `rendersMcpApps` is the explicit CLI-aware fact.
 */
export function buildHostCompatProfiles(): HostCompatProfile[] {
  return MARKET_HOSTS.map((host) => {
    const rendersOpenAiApps = getCompatRuntimeForStyle(host.id).injected;
    const rendersWidgets = host.rendersMcpApps || rendersOpenAiApps;
    return {
      ...host,
      rendersOpenAiApps,
      capabilities: rendersWidgets
        ? findHostStyle(host.id)?.mcp.mcpAppsCapabilities
        : undefined,
    };
  });
}
