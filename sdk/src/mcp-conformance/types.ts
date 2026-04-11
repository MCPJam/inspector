import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { MCPClientManager } from "../mcp-client-manager/index.js";

export const MCP_CHECK_CATEGORIES = [
  "core",
  "protocol",
  "tools",
  "prompts",
  "resources",
  "security",
  "transport",
] as const;

export type MCPCheckCategory = (typeof MCP_CHECK_CATEGORIES)[number];

export const MCP_CHECK_IDS = [
  "server-initialize",
  "ping",
  "logging-set-level",
  "completion-complete",
  "capabilities-consistent",
  "tools-list",
  "tools-input-schemas-valid",
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
  "server-sse-polling-session",
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
] as const;

export type MCPCheckId = (typeof MCP_CHECK_IDS)[number];

export type MCPCheckStatus = "passed" | "failed" | "skipped";

export interface MCPCheckResult {
  id: MCPCheckId;
  category: MCPCheckCategory;
  title: string;
  description: string;
  status: MCPCheckStatus;
  durationMs: number;
  error?: {
    message: string;
    details?: unknown;
  };
  details?: Record<string, unknown>;
}

export interface MCPConformanceConfig {
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
  checkTimeout?: number;
  categories?: MCPCheckCategory[];
  checkIds?: MCPCheckId[];
  fetchFn?: typeof fetch;
  clientName?: string;
}

export interface NormalizedMCPConformanceConfig {
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
  checkTimeout: number;
  categories: MCPCheckCategory[];
  checkIds?: MCPCheckId[];
  fetchFn: typeof fetch;
  clientName: string;
}

export interface MCPConformanceResult {
  passed: boolean;
  serverUrl: string;
  checks: MCPCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
    }
  >;
}

export interface MCPConformanceSuiteConfig {
  name?: string;
  serverUrl: string;
  defaults?: Partial<Omit<MCPConformanceConfig, "serverUrl">>;
  runs: Array<Partial<Omit<MCPConformanceConfig, "serverUrl">> & { label?: string }>;
}

export interface MCPConformanceSuiteResult {
  name: string;
  serverUrl: string;
  passed: boolean;
  results: Array<MCPConformanceResult & { label: string }>;
  summary: string;
  durationMs: number;
}

export interface MCPClientCheckContext {
  manager: MCPClientManager;
  client: Client;
  serverId: string;
  config: NormalizedMCPConformanceConfig;
  initializationInfo: ReturnType<MCPClientManager["getInitializationInfo"]>;
  availableTools: string[];
  availablePrompts: string[];
  availableResources: string[];
  availableResourceTemplates: string[];
}

export interface RawHttpCheckContext {
  config: NormalizedMCPConformanceConfig;
  serverUrl: string;
  fetchFn: typeof fetch;
}

export interface MCPClientCheckDefinition {
  id: MCPCheckId;
  category: Extract<MCPCheckCategory, "core" | "tools" | "prompts" | "resources">;
  title: string;
  description: string;
  run: (ctx: MCPClientCheckContext) => Promise<MCPCheckResult>;
}
