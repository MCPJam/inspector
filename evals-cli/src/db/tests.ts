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
    Logger.info("RunRecorder disabled - skipping suite creation");
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

  Logger.info("Creating RunRecorder with API key authentication");
  const client: DbClientInstance = dbClient();
  let precreated: PrecreatedSuite | undefined;

  const runDbAction = async <T>(
    action: string,
    payload: DbPayload,
  ): Promise<T | undefined> => {
    try {
      Logger.info(`[RunRecorder] Calling ${action}`);
      const result = await (client as any).action(action, payload);
      Logger.info(`[RunRecorder] ${action} completed successfully`);
      return result;
    } catch (error) {
      Logger.error(`[RunRecorder] ${action} failed: ${error}`);
      return undefined;
    }
  };

  const ensurePrecreated = async () => {
    if (precreated) {
      Logger.info("[RunRecorder] Using cached precreated suite");
      return precreated;
    }

    Logger.info("[RunRecorder] Creating new eval suite with API key");
    const result = await runDbAction<PrecreatedSuite>(
      "evals:precreateEvalSuiteWithApiKey",
      {
        apiKey,
        config,
        tests: config.tests,
      },
    );

    if (result) {
      Logger.success(
        `[RunRecorder] Suite created with ${result.testCases.length} test cases`,
      );
    } else {
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
  Logger.info("Creating RunRecorder with session authentication");
  let precreated: PrecreatedSuite | undefined;

  const runAction = async <T>(
    action: string,
    payload: DbPayload,
  ): Promise<T | undefined> => {
    try {
      Logger.info(`[RunRecorder:Auth] Calling ${action}`);
      const result = await convexClient.action(action as any, payload);
      Logger.info(`[RunRecorder:Auth] ${action} completed successfully`);
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
      Logger.info(`[RunRecorder:Auth] Calling mutation ${mutation}`);
      const result = await convexClient.mutation(mutation as any, payload);
      Logger.info(`[RunRecorder:Auth] ${mutation} completed successfully`);
      return result as T;
    } catch (error) {
      Logger.error(`[RunRecorder:Auth] ${mutation} failed: ${error}`);
      return undefined;
    }
  };

  const ensurePrecreated = async () => {
    if (precreated) {
      Logger.info("[RunRecorder:Auth] Using cached precreated suite");
      return precreated;
    }

    Logger.info("[RunRecorder:Auth] Creating new eval suite with session auth");
    const result = await runMutation<PrecreatedSuite>(
      "evals:precreateEvalSuiteWithAuth",
      {
        config,
        tests: config.tests,
      },
    );

    if (result) {
      Logger.success(
        `[RunRecorder:Auth] Suite created with ${result.testCases.length} test cases`,
      );
    } else {
      Logger.error("[RunRecorder:Auth] Failed to create suite");
    }

    precreated = result;
    return precreated;
  };

  return {
    enabled: true,
    async ensureSuite() {
      Logger.info("[RunRecorder:Auth] Ensuring suite exists");
      await ensurePrecreated();
    },
    async recordTestCase(test, index) {
      const current = await ensurePrecreated();
      if (!current) {
        Logger.warn("[RunRecorder:Auth] No suite available for test case recording");
        return undefined;
      }

      const zeroBasedIndex = index > 0 ? index - 1 : index;
      const testCaseId =
        current.testCases[zeroBasedIndex]?.testCaseId ??
        current.testCases[index]?.testCaseId;

      Logger.info(
        `[RunRecorder:Auth] Recording test case ${index}: ${testCaseId}`,
      );
      return testCaseId;
    },
    async startIteration({ testCaseId, iterationNumber, startedAt }) {
      if (!testCaseId) {
        Logger.warn("[RunRecorder:Auth] Cannot start iteration without testCaseId");
        return undefined;
      }

      const current = await ensurePrecreated();
      if (!current) {
        Logger.warn("[RunRecorder:Auth] No suite available for iteration start");
        return undefined;
      }

      const testEntry = current.testCases.find(
        (entry) => entry.testCaseId === testCaseId,
      );
      const iteration = testEntry?.iterations.find(
        (item) => item.iterationNumber === iterationNumber,
      );

      if (!iteration) {
        Logger.error(
          `[RunRecorder:Auth] Iteration ${iterationNumber} not found for test case ${testCaseId}`,
        );
        return undefined;
      }

      Logger.info(
        `[RunRecorder:Auth] Starting iteration ${iterationNumber} (${iteration.iterationId})`,
      );

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
        Logger.warn("[RunRecorder:Auth] Cannot finish iteration without iterationId");
        return;
      }

      Logger.info(
        `[RunRecorder:Auth] Finishing iteration ${iterationId}: ${passed ? "PASSED" : "FAILED"}`,
      );
      Logger.info(
        `[RunRecorder:Auth] Tools called: ${toolsCalled.join(", ")} | Tokens: ${usage.totalTokens ?? 0}`,
      );

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
