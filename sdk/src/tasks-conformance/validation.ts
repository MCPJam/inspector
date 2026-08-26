import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import {
  MCP_TASKS_CHECK_IDS,
  type MCPTasksCheckId,
  type MCPTasksConformanceConfig,
  type NormalizedMCPTasksConformanceConfig,
} from "./types.js";

function normalizeCheckIds(
  checkIds: MCPTasksConformanceConfig["checkIds"]
): MCPTasksCheckId[] | undefined {
  if (!checkIds || checkIds.length === 0) {
    return undefined;
  }

  const normalized = Array.from(new Set(checkIds));
  for (const checkId of normalized) {
    if (!MCP_TASKS_CHECK_IDS.includes(checkId)) {
      throw new Error(`Unknown MCP Tasks conformance check id: ${checkId}`);
    }
  }

  return normalized;
}

function deriveTarget(config: MCPServerConfig): string {
  return ("url" in config ? config.url : config.command) ?? "";
}

export function normalizeMCPTasksConformanceConfig(
  config: MCPTasksConformanceConfig
): NormalizedMCPTasksConformanceConfig {
  const { checkIds, toolName, toolArguments, pollTimeoutMs, inputResponses, ...rest } =
    config;
  const serverConfig = rest as MCPServerConfig;
  const target = deriveTarget(serverConfig).trim();

  if (!target) {
    throw new Error("MCP Tasks conformance config requires a target");
  }

  return {
    serverConfig,
    target,
    timeout: serverConfig.timeout ?? 30_000,
    pollTimeoutMs: pollTimeoutMs ?? 30_000,
    checkIds: normalizeCheckIds(checkIds),
    ...(toolName ? { toolName } : {}),
    ...(toolArguments ? { toolArguments } : {}),
    ...(inputResponses ? { inputResponses } : {}),
  };
}
