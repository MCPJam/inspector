import type {
  MCPReadResourceResult,
  MCPServerConfig,
} from "../mcp-client-manager/index.js";

export const MCP_APPS_CHECK_CATEGORIES = ["tools", "resources"] as const;

export type MCPAppsCheckCategory = (typeof MCP_APPS_CHECK_CATEGORIES)[number];

export const MCP_APPS_CHECK_IDS = [
  "ui-tools-present",
  "ui-tool-metadata-valid",
  "ui-tool-input-schema-valid",
  "ui-listed-resources-valid",
  "ui-resources-readable",
  "ui-resource-contents-valid",
  "ui-resource-meta-valid",
] as const;

export type MCPAppsCheckId = (typeof MCP_APPS_CHECK_IDS)[number];

export type MCPAppsCheckStatus = "passed" | "failed" | "skipped";

export interface MCPAppsCheckResult {
  id: MCPAppsCheckId;
  category: MCPAppsCheckCategory;
  title: string;
  description: string;
  status: MCPAppsCheckStatus;
  durationMs: number;
  error?: {
    message: string;
    details?: unknown;
  };
  details?: Record<string, unknown>;
  warnings?: string[];
}

export type MCPAppsConformanceConfig = MCPServerConfig & {
  checkIds?: MCPAppsCheckId[];
};

export interface NormalizedMCPAppsConformanceConfig {
  serverConfig: MCPServerConfig;
  target: string;
  timeout: number;
  checkIds?: MCPAppsCheckId[];
}

export interface MCPAppsResourceReadOutcome {
  uri: string;
  referencedByTools: string[];
  listed: boolean;
  result?: MCPReadResourceResult;
  error?: unknown;
}

export interface MCPAppsConformanceResult {
  passed: boolean;
  target: string;
  checks: MCPAppsCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPAppsCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
    }
  >;
  discovery: {
    toolCount: number;
    uiToolCount: number;
    listedResourceCount: number;
    listedUiResourceCount: number;
    checkedUiResourceCount: number;
  };
}
