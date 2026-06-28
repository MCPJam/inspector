/**
 * Client adapter over the shared host-compat engine (`@mcpjam/sdk/host-compat`).
 *
 * The verdict logic — deriving server requirements and evaluating them against
 * each host's capability matrix — lives in the SDK so every surface (inspector
 * UI, `mcpjam` CLI, public API, MCP server) shares one implementation. This
 * module is a thin presentation adapter: it runs the SDK's market-host
 * evaluation and joins the client-only presentation fields (per-host logos +
 * `rendersWidgets`) onto the SDK's logo-free reports, by host id.
 */

import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import {
  deriveServerRequirements,
  evaluateHostCompat,
  evaluateMarketHosts,
} from "@mcpjam/sdk/host-compat";
import { PROFILE_BY_ID } from "./profiles";
import type { WidgetUsage } from "./widget-scan";
import type {
  ConnectionFacts,
  HostCompatReport,
  ServerRequirements,
} from "./types";

// Re-export the SDK's pure verdict primitives so existing client importers keep
// a stable path. `evaluateHostCompat` here returns the SDK's logo-free report;
// surfaces that need logos go through `evaluateAllHosts` below.
export { deriveServerRequirements, evaluateHostCompat };

export type HostCompatEvaluation = {
  requirements: ServerRequirements;
  reports: HostCompatReport[];
};

/**
 * Evaluate the connected server against the market-host catalog, then join the
 * client presentation fields (logos + `rendersWidgets`) onto each logo-free SDK
 * report by host id.
 */
export function evaluateAllHosts(
  toolsData?: ListToolsResultWithMetadata | null,
  widgetUsage?: WidgetUsage,
  connectionFacts?: ConnectionFacts,
): HostCompatEvaluation {
  const { requirements, reports } = evaluateMarketHosts(toolsData, {
    widgetUsage,
    connectionFacts,
  });
  return {
    requirements,
    reports: reports.map((r) => {
      const profile = PROFILE_BY_ID[r.hostId];
      return {
        ...r,
        logoSrc: profile?.logoSrc ?? "",
        logoSrcByTheme: profile?.logoSrcByTheme,
        rendersWidgets: profile
          ? profile.rendersMcpApps || profile.rendersOpenAiApps
          : undefined,
      };
    }),
  };
}
