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
  advancedConfig?: Record<string, unknown>;
  testCaseId?: string;
};

export type EvalSuite = {
  _id: string;
  createdBy: string;
  name: string;
  description: string;
  configRevision: string;
  environment: {
    servers: string[];
  };
  createdAt: number;
  updatedAt: number;
  latestRunId?: string;
  defaultPassCriteria?: {
    minimumPassRate: number;
  };
  _creationTime?: number; // Convex auto field
};

export type EvalCase = {
  _id: string;
  testSuiteId: string;
  createdBy: string;
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
  advancedConfig?: Record<string, unknown>;
  lastMessageRun?: string | null;
  _creationTime?: number; // Convex auto field
};

export type EvalIteration = {
  _id: string;
  testCaseId?: string;
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
  runNumber: number;
  configRevision: string;
  configSnapshot: {
    tests: EvalSuiteConfigTest[];
    environment: { servers: string[] };
  };
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  summary?: EvalSuiteRunSummary;
  passCriteria?: {
    minimumPassRate: number;
  };
  result?: "pending" | "passed" | "failed" | "cancelled";
  notes?: string;
  createdAt: number;
  completedAt?: number;
  isActive?: boolean; // Mark runs as inactive when suite is edited
  _creationTime?: number;
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
