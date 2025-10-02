import { ModelMessage } from "ai";
import { ConvexHttpClient } from "convex/browser";

import { dbClient } from "../db";
import type { TestCase } from "../utils/validators";
import { Logger } from "../utils/logger";

export type UsageTotals = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type SuiteConfig = {
  tests: TestCase[];
  environment: { servers: string[] };
};

type DbPayload = Record<string, unknown>;

type DbClientInstance = ReturnType<typeof dbClient> | ConvexHttpClient;

type PrecreatedSuite = {
  suiteId: string;
  testCases: Array<{
    testCaseId: string;
    iterations: Array<{
      iterationId: string;
      iterationNumber: number;
    }>;
  }>;
};

export type RunRecorder = {
  enabled: boolean;
  ensureSuite(): Promise<void>;
  recordTestCase(test: TestCase, index: number): Promise<string | undefined>;
  startIteration(args: {
    testCaseId?: string;
    iterationNumber: number;
    startedAt: number;
  }): Promise<string | undefined>;
  finishIteration(args: {
    iterationId?: string;
    passed: boolean;
    toolsCalled: string[];
    usage: UsageTotals;
    messages: ModelMessage[];
  }): Promise<void>;
};

const createDisabledRecorder = (): RunRecorder => ({
  enabled: false,
  async ensureSuite() {
    return;
  },
  async recordTestCase() {
    return undefined;
  },
  async startIteration() {
    return undefined;
  },
  async finishIteration() {
    return;
  },
});

export const createRunRecorder = (
  apiKey: string | undefined,
  config: SuiteConfig,
): RunRecorder => {
  if (!apiKey) {
    Logger.warn("No API key provided - RunRecorder will be disabled");
    return createDisabledRecorder();
  }

  const client: DbClientInstance = dbClient();
  let precreated: PrecreatedSuite | undefined;

  const runDbAction = async <T>(
    action: string,
    payload: DbPayload,
  ): Promise<T | undefined> => {
    try {
      const result = await (client as any).action(action, payload);
      return result;
    } catch (error) {
      Logger.error(`[RunRecorder] ${action} failed: ${error}`);
      return undefined;
    }
  };

  const ensurePrecreated = async () => {
    if (precreated) {
      return precreated;
    }

    const result = await runDbAction<PrecreatedSuite>(
      "evals:precreateEvalSuiteWithApiKey",
      {
        apiKey,
        config,
        tests: config.tests,
      },
    );

    if (!result) {
      Logger.error("[RunRecorder] Failed to create suite");
    }

    precreated = result;
    return precreated;
  };

  return {
    enabled: true,
    async ensureSuite() {
      await ensurePrecreated();
    },
    async recordTestCase(test, index) {
      const current = await ensurePrecreated();
      if (!current) {
        return undefined;
      }

      const zeroBasedIndex = index > 0 ? index - 1 : index;
      return (
        current.testCases[zeroBasedIndex]?.testCaseId ??
        current.testCases[index]?.testCaseId
      );
    },
    async startIteration({ testCaseId, iterationNumber, startedAt }) {
      if (!testCaseId) {
        return undefined;
      }

      const current = await ensurePrecreated();
      if (!current) {
        return undefined;
      }

      const testEntry = current.testCases.find(
        (entry) => entry.testCaseId === testCaseId,
      );
      const iteration = testEntry?.iterations.find(
        (item) => item.iterationNumber === iterationNumber,
      );

      if (!iteration) {
        return undefined;
      }

      if (startedAt !== undefined) {
        await runDbAction("evals:updateEvalTestIterationResultWithApiKey", {
          apiKey,
          testId: iteration.iterationId,
          status: "running",
          result: "pending",
          startedAt,
        });
      }

      return iteration.iterationId;
    },
    async finishIteration({
      iterationId,
      passed,
      toolsCalled,
      usage,
      messages,
    }) {
      if (!iterationId) {
        return;
      }
      console.log(
        "finishIteration",
        iterationId,
        passed,
        toolsCalled,
        usage,
        messages,
      );
      await runDbAction("evals:updateEvalTestIterationResultWithApiKey", {
        apiKey,
        testId: iterationId,
        status: "completed",
        result: passed ? "passed" : "failed",
        actualToolCalls: toolsCalled,
        tokensUsed: usage.totalTokens ?? 0,
        blob: undefined,
        blobContent: { messages },
      });
    },
  };
};

export const createRunRecorderWithAuth = (
  convexClient: ConvexHttpClient,
  config: SuiteConfig,
): RunRecorder => {
  let precreated: PrecreatedSuite | undefined;

  const runAction = async <T>(
    action: string,
    payload: DbPayload,
  ): Promise<T | undefined> => {
    try {
      const result = await convexClient.action(action as any, payload);
      return result as T;
    } catch (error) {
      Logger.error(`[RunRecorder:Auth] ${action} failed: ${error}`);
      return undefined;
    }
  };

  const runMutation = async <T>(
    mutation: string,
    payload: DbPayload,
  ): Promise<T | undefined> => {
    try {
      const result = await convexClient.mutation(mutation as any, payload);
      return result as T;
    } catch (error) {
      Logger.error(`[RunRecorder:Auth] ${mutation} failed: ${error}`);
      return undefined;
    }
  };

  const ensurePrecreated = async () => {
    if (precreated) {
      return precreated;
    }

    const result = await runMutation<PrecreatedSuite>(
      "evals:precreateEvalSuiteWithAuth",
      {
        config,
        tests: config.tests,
      },
    );

    if (!result) {
      Logger.error("[RunRecorder:Auth] Failed to create suite");
    }

    precreated = result;
    return precreated;
  };

  return {
    enabled: true,
    async ensureSuite() {
      await ensurePrecreated();
    },
    async recordTestCase(test, index) {
      const current = await ensurePrecreated();
      if (!current) {
        return undefined;
      }

      const zeroBasedIndex = index > 0 ? index - 1 : index;
      const testCaseId =
        current.testCases[zeroBasedIndex]?.testCaseId ??
        current.testCases[index]?.testCaseId;

      return testCaseId;
    },
    async startIteration({ testCaseId, iterationNumber, startedAt }) {
      if (!testCaseId) {
        return undefined;
      }

      const current = await ensurePrecreated();
      if (!current) {
        return undefined;
      }

      const testEntry = current.testCases.find(
        (entry) => entry.testCaseId === testCaseId,
      );
      const iteration = testEntry?.iterations.find(
        (item) => item.iterationNumber === iterationNumber,
      );

      if (!iteration) {
        return undefined;
      }

      if (startedAt !== undefined) {
        await runAction("evals:updateEvalTestIterationResultWithAuth", {
          testId: iteration.iterationId,
          status: "running",
          result: "pending",
          startedAt,
        });
      }

      return iteration.iterationId;
    },
    async finishIteration({
      iterationId,
      passed,
      toolsCalled,
      usage,
      messages,
    }) {
      if (!iterationId) {
        return;
      }

      await runAction("evals:updateEvalTestIterationResultWithAuth", {
        testId: iterationId,
        status: "completed",
        result: passed ? "passed" : "failed",
        actualToolCalls: toolsCalled,
        tokensUsed: usage.totalTokens ?? 0,
        blob: undefined,
        blobContent: { messages },
      });
    },
  };
};
