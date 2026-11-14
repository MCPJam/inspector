import {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
  isKnownProtocolVersion,
  type MCPAppsCheckCategory,
  type MCPAppsCheckId,
  type MCPAppsConformanceConfig,
  type McpProtocolVersion,
} from "@mcpjam/sdk";
import { parseServerConfig, type SharedServerTargetOptions } from "./server-config.js";
import { usageError } from "./output.js";

const APPS_CHECK_IDS_BY_CATEGORY: Record<
  MCPAppsCheckCategory,
  readonly MCPAppsCheckId[]
> = {
  tools: [
    "ui-tools-present",
    "ui-tool-metadata-valid",
    "ui-tool-input-schema-valid",
  ],
  resources: [
    "ui-listed-resources-valid",
    "ui-resources-readable",
    "ui-resource-contents-valid",
    "ui-resource-meta-valid",
  ],
};

export interface AppsConformanceOptions extends SharedServerTargetOptions {
  category?: string[];
  checkId?: string[];
  protocolVersion?: string;
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowedValues: readonly string[],
): string[] {
  return (values ?? []).filter((value) => !allowedValues.includes(value));
}

export function buildAppsConformanceConfig(
  options: AppsConformanceOptions,
): MCPAppsConformanceConfig {
  const serverConfig = parseServerConfig(options);
  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_APPS_CHECK_CATEGORIES,
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`,
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_APPS_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${
        invalidCheckIds.length === 1 ? "" : "s"
      }: ${invalidCheckIds.join(", ")}`,
    );
  }

  const resolvedCheckIds =
    checkIds && checkIds.length > 0
      ? checkIds
      : categories && categories.length > 0
      ? Array.from(
          new Set(
            categories.flatMap(
              (category) =>
                APPS_CHECK_IDS_BY_CATEGORY[category as MCPAppsCheckCategory],
            ),
          ),
        )
      : undefined;

  const trimmedProtocolVersion = options.protocolVersion?.trim();
  let mcpProtocolVersion: McpProtocolVersion | undefined;
  if (trimmedProtocolVersion) {
    if (!isKnownProtocolVersion(trimmedProtocolVersion)) {
      throw usageError(`Unknown --protocol-version: ${trimmedProtocolVersion}`);
    }
    if (!("url" in serverConfig) || !serverConfig.url) {
      throw usageError(
        "--protocol-version can only be used with an HTTP target (--url).",
      );
    }
    mcpProtocolVersion = trimmedProtocolVersion;
  }

  return {
    ...serverConfig,
    ...(mcpProtocolVersion ? { mcpProtocolVersion } : {}),
    ...(resolvedCheckIds && resolvedCheckIds.length > 0
      ? { checkIds: resolvedCheckIds as MCPAppsConformanceConfig["checkIds"] }
      : {}),
  };
}
