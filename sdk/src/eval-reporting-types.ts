import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import type { EvalMatchOptions } from "./matchers.js";

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
export type EvalTraceSpanStatus = "ok" | "error";

export type EvalTraceSpanInput = {
  id: string;
  parentId?: string;
  name: string;
  category: EvalTraceSpanCategory;
  startMs: number;
  endMs: number;
  promptIndex?: number;
  stepIndex?: number;
  status?: EvalTraceSpanStatus;
  toolCallId?: string;
  toolName?: string;
  serverId?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  messageStartIndex?: number;
  messageEndIndex?: number;
  // GenAI harness metadata (step/llm spans). Mirror of inspector
  // shared/eval-trace.ts EvalTraceSpan; kept in parity via the shared fixture.
  finishReason?: string;
  provider?: string;
  responseId?: string;
  responseTimestamp?: string;
  ttfcMs?: number;
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
  injectedOpenAiCompat?: boolean;
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
  /**
   * Per-result match options. When present, the inspector snapshots
   * these onto the appended iteration's `testCaseSnapshot.matchOptions`
   * so historical pass/fail computation honors them.
   */
  matchOptions?: EvalMatchOptions;
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
  /**
   * MCPJam project id results are filed under (`MCPJAM_PROJECT_ID` env var
   * works too). Defaults to the API key org's Default project.
   */
  project?: string;
  serverNames?: string[];
  serverReplayConfigs?: MCPServerReplayConfig[];
  suiteName?: string;
  suiteDescription?: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  strict?: boolean;
  /**
   * When not `false`, auto-reported results fail if the trace shows tool
   * execution errors. Default: strict tool outcomes (equivalent to `true`).
   */
  failOnToolError?: boolean;
  externalRunId?: string;
  framework?: string;
  ci?: EvalCiMetadata;
  expectedIterations?: number;
  tags?: string[];
  /**
   * Host configuration that drove this eval run. Wire-level send is active
   * when the backend advertises capability `evalsHostConfig` (see
   * `GET /sdk/v1/info`). When `iteration.hostSnapshot` is present (Stage
   * 4 per-iteration capture), it takes precedence; this field is the
   * fallback for executors that don't expose `getHostSnapshot` and runs
   * without per-iteration capture. The reporter computes the content
   * hash internally — callers never set `hostConfigHash`.
   */
  host?: import("./host-config/host.js").Host;
};

export type ReportEvalResultsInput = MCPJamReportingConfig & {
  suiteName: string;
  results: EvalResultInput[];
  agent?: {
    getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
  };
  /**
   * Optional executor surface used by Stage 5 host-config wire pickup as
   * a fallback when no per-iteration `hostSnapshot` and no
   * {@link MCPJamReportingConfig.host} were supplied. Structurally typed
   * so any object exposing `getHostSnapshot()` (e.g. `HostRunner`,
   * `HostRuntime`) qualifies — the reporter never holds a reference
   * beyond reading the snapshot.
   */
  executor?: {
    getHostSnapshot?: () =>
      | import("./host-config/public-types.js").HostJson
      | undefined;
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
