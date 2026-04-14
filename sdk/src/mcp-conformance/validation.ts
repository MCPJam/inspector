import {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  type MCPCheckCategory,
  type MCPCheckId,
  type MCPConformanceConfig,
  type NormalizedMCPConformanceConfig,
} from "./types.js";

function normalizeCategories(
  categories: MCPConformanceConfig["categories"],
): MCPCheckCategory[] {
  if (!categories || categories.length === 0) {
    return [...MCP_CHECK_CATEGORIES];
  }

  const normalized = Array.from(new Set(categories));
  for (const category of normalized) {
    if (!MCP_CHECK_CATEGORIES.includes(category)) {
      throw new Error(`Unknown MCP conformance category: ${category}`);
    }
  }

  return normalized;
}

function normalizeCheckIds(
  checkIds: MCPConformanceConfig["checkIds"],
): MCPCheckId[] | undefined {
  if (!checkIds || checkIds.length === 0) {
    return undefined;
  }

  const normalized = Array.from(new Set(checkIds));
  for (const checkId of normalized) {
    if (!MCP_CHECK_IDS.includes(checkId)) {
      throw new Error(`Unknown MCP conformance check id: ${checkId}`);
    }
  }

  return normalized;
}

export function normalizeMCPConformanceConfig(
  config: MCPConformanceConfig,
): NormalizedMCPConformanceConfig {
  const serverUrl = config.serverUrl.trim();
  if (!serverUrl) {
    throw new Error("MCP conformance config requires serverUrl");
  }

  try {
    new URL(serverUrl);
  } catch {
    throw new Error(`Invalid MCP conformance serverUrl: ${serverUrl}`);
  }

  const categories = normalizeCategories(config.categories);
  const checkIds = normalizeCheckIds(config.checkIds);

  return {
    serverUrl,
    accessToken: config.accessToken,
    customHeaders: config.customHeaders,
    checkTimeout: config.checkTimeout ?? 30_000,
    categories,
    checkIds,
    fetchFn: config.fetchFn ?? fetch,
    clientName: config.clientName?.trim() || "mcpjam-sdk-conformance",
  };
}
