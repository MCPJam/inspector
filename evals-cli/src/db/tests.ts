import { ModelMessage } from "ai";

import { dbClient } from "../db";
import type { TestCase } from "../utils/validators";

export type ConfigSummary = {
  tests: TestCase[];
  environment: { servers: string[] };
  llms: string[];
};

export type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

type DbClientInstance = ReturnType<typeof dbClient> | null;

export type PersistenceContext = {
  enabled: boolean;
  apiKey?: string;
  db: DbClientInstance;
  testRunId?: string;
  configSummary: ConfigSummary;
  totalPlannedTests: number;
};

type DbPayload = Record<string, unknown>;

const runDbAction = async <T>(
  persistence: PersistenceContext,
  action: string,
  payload: DbPayload,
): Promise<T | undefined> => {
  if (!persistence.enabled || !persistence.db) {
    return undefined;
  }

  try {
    return await (persistence.db as any).action(action, payload);
  } catch {
    return undefined;
  }
};

export const createPersistenceContext = (
  apiKey: string | undefined,
  configSummary: ConfigSummary,
  totalPlannedTests: number,
): PersistenceContext => ({
  enabled: Boolean(apiKey),
  apiKey,
  db: apiKey ? dbClient() : null,
  configSummary,
  totalPlannedTests,
});

export const ensureSuiteRecord = async (
  persistence: PersistenceContext,
) => {
  if (
    !persistence.enabled ||
    !persistence.apiKey ||
    persistence.testRunId
  ) {
    return;
  }

  const createdId = await runDbAction<string>(
    persistence,
    "evals:createEvalTestSuiteWithApiKey",
    {
      apiKey: persistence.apiKey,
      name: undefined,
      config: persistence.configSummary,
      totalTests: persistence.totalPlannedTests,
    },
  );

  if (createdId) {
    persistence.testRunId = createdId;
  }
};

export const createTestCaseRecord = async (
  persistence: PersistenceContext,
  test: TestCase,
  testNumber: number,
) => {
  if (!persistence.enabled || !persistence.apiKey) {
    return undefined;
  }

  const testCaseId = await runDbAction<string>(
    persistence,
    "evals:createEvalTestCaseWithApiKey",
    {
      apiKey: persistence.apiKey,
      title: String(test.title ?? `Group ${testNumber}`),
      query: String(test.query ?? ""),
      provider: String(test.provider ?? ""),
      model: String(test.model ?? ""),
      runs: Number(test.runs ?? 1),
    },
  );

  if (!persistence.testRunId) {
    await ensureSuiteRecord(persistence);
  }

  return testCaseId;
};

export const createIterationRecord = async (
  persistence: PersistenceContext,
  testCaseId: string | undefined,
  iterationNumber: number,
  startedAt: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !testCaseId) {
    return undefined;
  }

  return await runDbAction<string>(
    persistence,
    "evals:createEvalTestIterationWithApiKey",
    {
      apiKey: persistence.apiKey,
      testCaseId,
      startedAt,
      iterationNumber,
      blob: undefined,
      actualToolCalls: [],
      tokensUsed: 0,
    },
  );
};

export const updateIterationResult = async (
  persistence: PersistenceContext,
  evalTestId: string | undefined,
  passed: boolean,
  toolsCalled: string[],
  tokensUsed: UsageTotals,
  messages: ModelMessage[],
) => {
  if (!persistence.enabled || !persistence.apiKey || !evalTestId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestIterationResultWithApiKey",
    {
      apiKey: persistence.apiKey,
      testId: evalTestId,
      status: "completed",
      result: passed ? "passed" : "failed",
      actualToolCalls: toolsCalled,
      tokensUsed: tokensUsed.totalTokens ?? 0,
      blob: undefined,
      blobContent: { messages },
    },
  );
};

export const updateTestCaseResult = async (
  persistence: PersistenceContext,
  testCaseId: string | undefined,
  passedRuns: number,
  failedRuns: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !testCaseId) {
    return;
  }

  const result = failedRuns > 0 ? "failed" : "passed";

  await runDbAction(
    persistence,
    "evals:updateEvalTestCaseResultWithApiKey",
    {
      apiKey: persistence.apiKey,
      testCaseId,
      result,
    },
  );
};

export const markSuiteFailed = async (persistence: PersistenceContext) => {
  if (!persistence.enabled || !persistence.apiKey || !persistence.testRunId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestSuiteStatusWithApiKey",
    {
      apiKey: persistence.apiKey,
      testRunId: persistence.testRunId,
      status: "running",
      result: "failed",
    },
  );
};

export const finalizeSuiteStatus = async (
  persistence: PersistenceContext,
  failedRuns: number,
) => {
  if (!persistence.enabled || !persistence.apiKey || !persistence.testRunId) {
    return;
  }

  await runDbAction(
    persistence,
    "evals:updateEvalTestSuiteStatusWithApiKey",
    {
      apiKey: persistence.apiKey,
      testRunId: persistence.testRunId,
      status: "completed",
      result: failedRuns > 0 ? "failed" : "passed",
      finishedAt: Date.now(),
    },
  );
};
