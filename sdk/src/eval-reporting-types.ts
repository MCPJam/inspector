import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";

export type EvalExpectedToolCall = {
  toolName: string;
  arguments?: Record<string, unknown>;
};

export type EvalCiMetadata = {
  provider?: string;
  pipelineId?: string;
  jobId?: string;
  runUrl?: string;
  branch?: string;
  commitSha?: string;
};

export type EvalTraceSpanCategory = "step" | "llm" | "tool" | "error";

export type EvalTraceSpanInput = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
};

export type EvalTraceInput =
  | string
  | Array<{ role: string; content: unknown }>
  | {
      messages?: Array<{ role: string; content: unknown }>;
      spans?: EvalTraceSpanInput[];
      prompts?: unknown[];
      raw?: unknown;
    };

export type EvalWidgetCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

export type EvalWidgetPermissions = {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
};

export type EvalWidgetSnapshotInput = {
  toolCallId: string;
  toolName: string;
  protocol: "mcp-apps";
  serverId: string;
  resourceUri: string;
  toolMetadata: Record<string, unknown>;
  widgetCsp: EvalWidgetCsp | null;
  widgetPermissions: EvalWidgetPermissions | null;
  widgetPermissive: boolean;
  prefersBorder: boolean;
  widgetHtml?: string;
  widgetHtmlBlobId?: string;
};

export type EvalResultInput = {
  caseTitle: string;
  query?: string;
  passed: boolean;
  durationMs?: number;
  provider?: string;
  model?: string;
  expectedToolCalls?: EvalExpectedToolCall[];
  actualToolCalls?: EvalExpectedToolCall[];
  tokens?: { input?: number; output?: number; total?: number };
  error?: string;
  errorDetails?: string;
  trace?: EvalTraceInput;
  externalIterationId?: string;
  externalCaseId?: string;
  metadata?: Record<string, string | number | boolean>;
  isNegativeTest?: boolean;
  advancedConfig?: Record<string, unknown>;
  widgetSnapshots?: EvalWidgetSnapshotInput[];
};

export type MCPServerReplayConfig = {
  serverId: string;
  url: string;
  preferSSE?: boolean;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
};

export type MCPJamReportingConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  serverNames?: string[];
  serverReplayConfigs?: MCPServerReplayConfig[];
  suiteName?: string;
  suiteDescription?: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  strict?: boolean;
  externalRunId?: string;
  framework?: string;
  ci?: EvalCiMetadata;
  expectedIterations?: number;
  tags?: string[];
};

export type ReportEvalResultsInput = MCPJamReportingConfig & {
  suiteName: string;
  results: EvalResultInput[];
  agent?: {
    getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
  };
  mcpClientManager?: MCPClientManager;
};

export type ReportEvalResultsOutput = {
  suiteId: string;
  runId: string;
  status: "completed" | "failed";
  result: "passed" | "failed";
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
};
