import {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  PROTOCOL_VERSION_ERAS,
  type MCPCheckCategory,
  type MCPCheckEra,
  type MCPCheckId,
  type MCPConformanceConfig,
  type NormalizedMCPConformanceConfig,
} from "./types.js";
import {
  isKnownProtocolVersion,
  type McpProtocolVersion,
} from "../mcp-client-manager/mcp-protocol-version.js";

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

/**
 * Era of a protocol version, read off the {@link PROTOCOL_VERSION_ERAS}
 * registry (§15.1). An unrecognized version is a CONFIGURATION ERROR, never a
 * silent fall back to legacy: running the legacy check set against a version
 * nobody classified would report a verdict about the wrong requirements.
 */
export function eraForProtocolVersion(protocolVersion: string): MCPCheckEra {
  if (!isKnownProtocolVersion(protocolVersion)) {
    throw new Error(
      `Unknown MCP conformance protocolVersion: ${protocolVersion}`,
    );
  }
  return PROTOCOL_VERSION_ERAS[protocolVersion];
}

function normalizeProtocolVersion(
  protocolVersion: MCPConformanceConfig["protocolVersion"],
): { protocolVersion?: McpProtocolVersion; era: MCPCheckEra } {
  if (protocolVersion === undefined) {
    // Unset ⇒ legacy era ⇒ byte-identical pre-era-awareness behavior.
    return { era: "legacy" };
  }

  return {
    protocolVersion,
    era: eraForProtocolVersion(protocolVersion),
  };
}

function normalizeToolProbe(
  probe: MCPConformanceConfig["inputRequiredProbe"],
  optionName: "inputRequiredProbe" | "logProbe",
): NormalizedMCPConformanceConfig["inputRequiredProbe"] {
  if (!probe) {
    return undefined;
  }

  const toolName = probe.toolName.trim();
  if (!toolName) {
    throw new Error(
      `MCP conformance ${optionName} requires a non-empty toolName`,
    );
  }

  return { toolName, arguments: probe.arguments };
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
  const { protocolVersion, era } = normalizeProtocolVersion(
    config.protocolVersion,
  );

  return {
    serverUrl,
    accessToken: config.accessToken,
    customHeaders: config.customHeaders,
    checkTimeout: config.checkTimeout ?? 30_000,
    categories,
    checkIds,
    fetchFn: config.fetchFn ?? fetch,
    clientName: config.clientName?.trim() || "mcpjam-sdk-conformance",
    protocolVersion,
    era,
    inputRequiredProbe: normalizeToolProbe(
      config.inputRequiredProbe,
      "inputRequiredProbe",
    ),
    logProbe: normalizeToolProbe(config.logProbe, "logProbe"),
  };
}
