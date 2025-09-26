export type EvalSuite = {
    _id: string;
    createdBy: string;
    status: "running" | "completed" | "failed" | "cancelled";
    result: "pending" | "passed" | "failed" | "cancelled";
    startedAt: number;
    finishedAt?: number;
    totalTests: number;
    config: { tests: unknown; environment: unknown; llms: unknown };
  };
  
export type EvalCase = {
    _id: string;
    createdBy: string;
    title: string;
    query: string;
    provider: string;
    model: string;
    runs: number;
    result: "pending" | "passed" | "failed" | "cancelled";
  };
  
export type EvalIteration = {
    _id: string;
    testCaseId?: string;
    createdBy: string;
    createdAt: number;
    startedAt: number;
    iterationNumber: number;
    updatedAt: number;
    blob?: string;
    status: "running" | "completed" | "failed" | "cancelled";
    result: "pending" | "passed" | "failed" | "cancelled";
    actualToolCalls: string[];
    tokensUsed: number;
  };

export type SuiteAggregate = {
    filteredIterations: EvalIteration[];
    totals: { passed: number; failed: number; cancelled: number; tokens: number };
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