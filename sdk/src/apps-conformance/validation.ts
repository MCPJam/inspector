import {
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  type MCPServerConfig,
} from "../mcp-client-manager/index.js";
import {
  MCP_APPS_CHECK_IDS,
  type MCPAppsCheckId,
  type MCPAppsConformanceConfig,
  type NormalizedMCPAppsConformanceConfig,
} from "./types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCheckIds(
  checkIds: MCPAppsConformanceConfig["checkIds"],
): MCPAppsCheckId[] | undefined {
  if (!checkIds || checkIds.length === 0) {
    return undefined;
  }

  const normalized = Array.from(new Set(checkIds));
  for (const checkId of normalized) {
    if (!MCP_APPS_CHECK_IDS.includes(checkId)) {
      throw new Error(`Unknown MCP Apps conformance check id: ${checkId}`);
    }
  }

  return normalized;
}

function deriveTarget(config: MCPServerConfig): string {
  return ("url" in config ? config.url : config.command) ?? "";
}

function ensureUiCapability(config: MCPServerConfig): MCPServerConfig {
  if (!("clientCapabilities" in config) || !config.clientCapabilities) {
    return config;
  }

  const mergedCapabilities = mergeClientCapabilities(
    getDefaultClientCapabilities(),
    config.clientCapabilities,
  );

  const capabilityRecord = mergedCapabilities as Record<string, unknown>;
  const extensions = isPlainObject(capabilityRecord.extensions)
    ? { ...capabilityRecord.extensions }
    : {};
  const uiExtension = isPlainObject(extensions[MCP_UI_EXTENSION_ID])
    ? { ...(extensions[MCP_UI_EXTENSION_ID] as Record<string, unknown>) }
    : {};
  const existingMimeTypes = Array.isArray(uiExtension.mimeTypes)
    ? uiExtension.mimeTypes.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];

  extensions[MCP_UI_EXTENSION_ID] = {
    ...uiExtension,
    mimeTypes: [
      MCP_UI_RESOURCE_MIME_TYPE,
      ...existingMimeTypes.filter(
        (value) => value !== MCP_UI_RESOURCE_MIME_TYPE,
      ),
    ],
  };

  return {
    ...config,
    clientCapabilities: {
      ...(mergedCapabilities as Record<string, unknown>),
      extensions,
    } as MCPServerConfig["clientCapabilities"],
  };
}

export function normalizeMCPAppsConformanceConfig(
  config: MCPAppsConformanceConfig,
): NormalizedMCPAppsConformanceConfig {
  const { checkIds, ...serverConfig } = config;
  const normalizedServerConfig = ensureUiCapability(serverConfig as MCPServerConfig);
  const target = deriveTarget(normalizedServerConfig).trim();

  if (!target) {
    throw new Error("MCP Apps conformance config requires a target");
  }

  return {
    serverConfig: normalizedServerConfig,
    target,
    timeout: normalizedServerConfig.timeout ?? 30_000,
    checkIds: normalizeCheckIds(checkIds),
  };
}
