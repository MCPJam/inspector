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
  triageStatus?: "pending" | "completed" | "failed";
  triageSummary?: {
    summary: string;
    failureCategories: Array<{
      category: string;
      count: number;
      testCaseTitles: string[];
      recommendation: string;
    }>;
    topRecommendations: string[];
    suggestedTestCases?: Array<{
      title: string;
      query: string;
      /** Present only on older persisted runs; UI always uses `runs: 1` on create. */
      runs?: number;
      expectedToolCalls: Array<{
        toolName: string;
        arguments: Record<string, any>;
      }>;
      isNegativeTest?: boolean;
      scenario?: string;
      expectedOutput?: string;
      rationale?: string;
    }>;
    generatedAt: number;
    modelUsed: string;
  };
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
