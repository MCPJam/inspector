import { validateTaskOverrides } from "./plan.js";
import type { MCPServerConfig } from "../mcp-client-manager/index.js";
import {
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_READINESS_IDS,
  RENAMED_MCP_TASKS_CHECK_IDS,
  type MCPTasksCheckId,
  type MCPTasksConformanceConfig,
  type MCPTasksReadinessId,
  type NormalizedMCPTasksConformanceConfig,
} from "./types.js";

function normalizeCheckIds(
  checkIds: MCPTasksConformanceConfig["checkIds"]
): MCPTasksCheckId[] | undefined {
  if (!checkIds || checkIds.length === 0) {
    return undefined;
  }

  // A renamed id runs under its current name.
  const normalized = Array.from(
    new Set(
      checkIds.map((id) =>
        Object.hasOwn(RENAMED_MCP_TASKS_CHECK_IDS, id)
          ? RENAMED_MCP_TASKS_CHECK_IDS[
              id as keyof typeof RENAMED_MCP_TASKS_CHECK_IDS
            ]
          : (id as MCPTasksCheckId)
      )
    )
  );
  for (const checkId of normalized) {
    if (!MCP_TASKS_CHECK_IDS.includes(checkId)) {
      throw new Error(`Unknown MCP Tasks conformance check id: ${checkId}`);
    }
  }

  return normalized;
}

/** Unlike check ids, an empty list stays empty: it means no advice at all. */
function normalizeReadinessIds(
  readinessIds: MCPTasksReadinessId[]
): MCPTasksReadinessId[] {
  const normalized = Array.from(new Set(readinessIds));
  for (const readinessId of normalized) {
    if (!MCP_TASKS_READINESS_IDS.includes(readinessId)) {
      throw new Error(`Unknown MCP Tasks readiness id: ${readinessId}`);
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
  const {
    signal,
    checkIds,
    readinessIds,
    checkOverrides,
    toolName,
    toolArguments,
    pollTimeoutMs,
    inputResponses,
    ...rest
  } = config;
  const serverConfig = rest as MCPServerConfig;
  const target = deriveTarget(serverConfig).trim();

  if (!target) {
    throw new Error("MCP Tasks conformance config requires a target");
  }

  return {
    signal,
    serverConfig,
    target,
    timeout: serverConfig.timeout ?? 30_000,
    pollTimeoutMs: pollTimeoutMs ?? 30_000,
    checkIds: normalizeCheckIds(checkIds),
    ...(readinessIds !== undefined
      ? { readinessIds: normalizeReadinessIds(readinessIds) }
      : {}),
    ...(checkOverrides
      ? { checkOverrides: validateTaskOverrides(checkOverrides) }
      : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolArguments ? { toolArguments } : {}),
    ...(inputResponses ? { inputResponses } : {}),
  };
}
