export type EvalSuite = {
  _id: string;
  createdBy: string;
  config: { tests: unknown; environment: unknown };
  _creationTime?: number; // Convex auto field
};

export type EvalCase = {
  _id: string;
  evalTestSuiteId: string;
  createdBy: string;
  title: string;
  query: string;
  provider: string;
  model: string;
  expectedToolCalls: string[];
  _creationTime?: number; // Convex auto field
};

export type EvalIteration = {
  _id: string;
  testCaseId?: string;
  createdBy: string;
  createdAt: number;
  startedAt?: number;
  iterationNumber: number;
  updatedAt: number;
  blob?: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result: "pending" | "passed" | "failed" | "cancelled";
  actualToolCalls: string[];
  tokensUsed: number;
  _creationTime?: number; // Convex auto field
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
