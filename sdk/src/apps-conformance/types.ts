import type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
} from "../conformance-outcome.js";
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

/** @see {@link ConformanceSkipReason} — the vocabulary is shared by every suite. */
export type MCPAppsSkipReason = ConformanceSkipReason;

/** @see {@link ConformanceRunOutcome} — the vocabulary is shared by every suite. */
export type MCPAppsRunOutcome = ConformanceRunOutcome;

export interface MCPAppsCheckResult {
  id: MCPAppsCheckId;
  category: MCPAppsCheckCategory;
  title: string;
  description: string;
  status: MCPAppsCheckStatus;
  /** Always set when `status` is `"skipped"`. */
  skipReason?: MCPAppsSkipReason;
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

export type MCPAppsConformanceSuiteDefaults = Partial<
  Omit<MCPAppsConformanceConfig, keyof MCPServerConfig>
>;

export type MCPAppsConformanceSuiteRun = Partial<
  Omit<MCPAppsConformanceConfig, keyof MCPServerConfig>
> & {
  label?: string;
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
  /**
   * True ONLY when `outcome` is `"passed"`: every selected check either ran and
   * passed or was inapplicable to this server. A check that could not run keeps
   * this false, so a skip can never add up to a green run.
   */
  passed: boolean;
  outcome: MCPAppsRunOutcome;
  /**
   * Present when `outcome` is `"incomplete"`: which checks did not run and what
   * the caller has to change to make them run.
   */
  incompleteReason?: string;
  target: string;
  /**
   * The revision the run's connection negotiated (or the caller pinned).
   * Absent when the connection never succeeded — the run established no
   * version, and a score label must not invent one.
   */
  protocolVersion?: string;
  checks: MCPAppsCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPAppsCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      /** Every skip, of either reason. */
      skipped: number;
      /** The subset of `skipped` that is `"could-not-run"`. */
      couldNotRun: number;
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

export interface MCPAppsConformanceSuiteConfig {
  name?: string;
  target: MCPServerConfig;
  defaults?: MCPAppsConformanceSuiteDefaults;
  runs: MCPAppsConformanceSuiteRun[];
}

export interface MCPAppsConformanceSuiteResult {
  name: string;
  target: string;
  passed: boolean;
  results: Array<MCPAppsConformanceResult & { label: string }>;
  summary: string;
  durationMs: number;
}
