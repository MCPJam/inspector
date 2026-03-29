export type EvalSuiteConfigTest = {
  title: string;
  query: string;
  provider: string;
  model: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  scenario?: string; // Description of why app should NOT trigger (negative tests only)
  expectedOutput?: string; // The output or experience expected from the MCP server
  advancedConfig?: Record<string, unknown>;
  testCaseId?: string;
};

export type EvalSuite = {
  _id: string;
  createdBy: string;
  workspaceId?: string;
  name: string;
  description: string;
  configRevision: string;
  environment: {
    servers: string[];
    serverBindings?: Array<{
      serverName: string;
      workspaceServerId?: string;
    }>;
  };
  createdAt: number;
  updatedAt: number;
  latestRunId?: string;
  source?: "ui" | "sdk";
  runCounter?: number;
  defaultPassCriteria?: {
    minimumPassRate: number;
  };
  _creationTime?: number; // Convex auto field
  tags?: string[];
};

export type EvalCase = {
  _id: string;
  testSuiteId: string;
  createdBy: string;
  workspaceId?: string;
  caseKey?: string;
  title: string;
  query: string;
  models: Array<{
    model: string;
    provider: string;
  }>;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
  scenario?: string; // Description of why app should NOT trigger (negative tests only)
  expectedOutput?: string; // The output or experience expected from the MCP server
  advancedConfig?: Record<string, unknown>;
  lastMessageRun?: string | null;
  _creationTime?: number; // Convex auto field
};

export type EvalIteration = {
  _id: string;
  testCaseId?: string;
  workspaceId?: string;
  testCaseSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    provider: string;
    model: string;
    runs?: number;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean; // When true, test passes if NO tools are called
    scenario?: string; // Description of why app should NOT trigger (negative tests only)
    expectedOutput?: string; // The output or experience expected from the MCP server
    advancedConfig?: Record<string, unknown>;
  };
  suiteRunId?: string;
  configRevision?: string;
  createdBy: string;
  createdAt: number;
  startedAt?: number;
  iterationNumber: number;
  updatedAt: number;
  blob?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: "pending" | "passed" | "failed" | "cancelled";
  actualToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  tokensUsed: number;
  error?: string;
  errorDetails?: string;
  resultSource?: "reported" | "derived";
  externalIterationId?: string;
  metadata?: Record<string, string | number | boolean>;
  _creationTime?: number; // Convex auto field
};

export type EvalSuiteRunSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
};

export type EvalSuiteRun = {
  _id: string;
  suiteId: string;
  createdBy: string;
  workspaceId?: string;
  runNumber: number;
  configRevision: string;
  configSnapshot: {
    tests: EvalSuiteConfigTest[];
    environment: {
      servers: string[];
      serverBindings?: Array<{
        serverName: string;
        workspaceServerId?: string;
      }>;
    };
  };
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  summary?: EvalSuiteRunSummary;
  passCriteria?: {
    minimumPassRate: number;
  };
  result?: "pending" | "passed" | "failed" | "cancelled";
  source?: "ui" | "sdk";
  replayedFromRunId?: string;
  /** Set when this run was created by the Auto fix suite replay step. */
  traceRepairJobId?: string;
  hasServerReplayConfig?: boolean;
  externalRunId?: string;
  framework?: string;
  ciMetadata?: {
    provider?: string;
    pipelineId?: string;
    jobId?: string;
    runUrl?: string;
    branch?: string;
    commitSha?: string;
  };
  notes?: string;
  createdAt: number;
  completedAt?: number;
  /** Legacy field from Convex; no longer used for UI gating or trends. */
  isActive?: boolean;
  expectedIterations?: number;
  _creationTime?: number;
  runInsightsJobId?: number;
  runInsightsStatus?: "pending" | "completed" | "failed";
  runInsights?: {
    summary: string;
    generatedAt: number;
    modelUsed: string;
    baselineRunId?: string;
    toolSnapshotHash?: string;
    caseInsights: Array<{
      caseKey: string;
      testCaseId?: string;
      title: string;
      status:
        | "new_failure"
        | "still_failing"
        | "fixed"
        | "new_case"
        | "removed_case";
      summary: string;
    }>;
  };
};

export type EvalRefinementSession = {
  _id: string;
  status:
    | "pending_candidate"
    | "ready"
    | "verifying"
    | "completed"
    | "failed";
  outcome?: "improved_test" | "still_ambiguous" | "server_likely";
  failureSignature?: string;
  testWeaknessHypothesis?: string;
  serverHypothesis?: string;
  confidenceChecklist?: string[];
  candidateParaphraseQuery?: string;
  verificationRuns: Array<{
    label: string;
    iterationId?: string;
    provider: string;
    model: string;
    query: string;
    passed: boolean;
    failureSignature?: string;
  }>;
  attributionSummary?: string;
  promotedAt?: number;
  updatedAt: number;
  baseSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    runs: number;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    advancedConfig?: Record<string, unknown>;
  };
  candidateSnapshot?: {
    caseKey?: string;
    title: string;
    query: string;
    runs: number;
    models: Array<{ model: string; provider: string }>;
    expectedToolCalls: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    isNegativeTest?: boolean;
    scenario?: string;
    expectedOutput?: string;
    advancedConfig?: Record<string, unknown>;
  };
};

export type EvalRunRefinementCase = {
  sourceIterationId: string;
  testCaseId?: string;
  caseKey: string;
  title: string;
  query: string;
  failureSignature?: string;
  failureStreak: number;
  session: EvalRefinementSession | null;
};

export type EvalSuiteOverviewEntry = {
  suite: EvalSuite;
  latestRun: EvalSuiteRun | null;
  recentRuns: EvalSuiteRun[];
  passRateTrend: number[];
  totals: {
    passed: number;
    failed: number;
    runs: number;
  };
};

export type SuiteAggregate = {
  filteredIterations: EvalIteration[];
  totals: {
    passed: number;
    failed: number;
    cancelled: number;
    pending: number;
    tokens: number;
  };
  byCase: Array<{
    testCaseId: string;
    title: string;
    provider: string;
    model: string;
    runs: number;
    passed: number;
    failed: number;
    cancelled: number;
    tokens: number;
  }>;
};

// Query response types for Convex queries
export type SuiteDetailsQueryResponse = {
  testCases: EvalCase[];
  iterations: EvalIteration[];
};

export type TagGroupAggregate = {
  tag: string;
  suiteCount: number;
  totals: { passed: number; failed: number; runs: number };
  passRate: number; // 0-100
  entries: EvalSuiteOverviewEntry[];
};

export type CommitGroup = {
  commitSha: string;
  shortSha: string; // first 7 chars
  branch: string | null;
  timestamp: number; // most recent run time
  status: "passed" | "failed" | "running" | "mixed";
  runs: EvalSuiteRun[];
  suiteMap: Map<string, string>; // suiteId → suite name
  summary: { total: number; passed: number; failed: number; running: number };
};
