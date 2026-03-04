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

export type EvalTraceInput =
  | string
  | Array<{ role: string; content: unknown }>
  | {
      messages?: Array<{ role: string; content: unknown }>;
      prompts?: unknown[];
      raw?: unknown;
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
};

export type MCPJamReportingConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  serverNames?: string[];
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
};

export type ReportEvalResultsInput = MCPJamReportingConfig & {
  suiteName: string;
  results: EvalResultInput[];
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
