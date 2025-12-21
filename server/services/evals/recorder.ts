import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { UsageTotals } from "./types";
import { logger } from "../../utils/logger";

type IterationStatus = "completed" | "failed" | "cancelled";

export type SuiteRunRecorder = {
  runId: string;
  suiteId: string;
  startIteration(args: {
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
      isNegativeTest?: boolean; // When true, test passes if NO tools are called
      advancedConfig?: Record<string, unknown>;
    };
    iterationNumber: number;
    startedAt: number;
  }): Promise<string | undefined>;
  finishIteration(args: {
    iterationId?: string;
    passed: boolean;
    toolsCalled: Array<{
      toolName: string;
      arguments: Record<string, any>;
    }>;
    usage: UsageTotals;
    messages: ModelMessage[];
    status?: IterationStatus;
    startedAt?: number;
    error?: string;
    errorDetails?: string;
  }): Promise<void>;
  finalize(args: {
    status: "completed" | "failed" | "cancelled";
    summary?: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    notes?: string;
  }): Promise<void>;
};

const DEFAULT_ITERATION_STATUS: IterationStatus = "completed";

export const createSuiteRunRecorder = ({
  convexClient,
  suiteId,
  runId,
}: {
  convexClient: ConvexHttpClient;
  suiteId: string;
  runId: string;
}): SuiteRunRecorder => {
  let runDeleted = false; // Track if run was deleted

  return {
    runId,
    suiteId,
    async startIteration({
      testCaseId,
      testCaseSnapshot,
      iterationNumber,
      startedAt,
    }) {
      if (runDeleted) {
        // Silently skip if run was deleted
        return undefined;
      }

      try {
        // In the new data model, iterations are pre-created by precreateIterationsForRun
        // We need to find the correct iteration and mark it as running

        // Query all iterations for this run
        const response = await convexClient.query(
          "testSuites:getTestSuiteRunDetails" as any,
          { runId },
        );

        const iterations = response?.iterations || [];

        // Find the iteration that matches this test case and iteration number
        // Match by testCaseSnapshot if available, otherwise by testCaseId
        const matchingIteration = iterations.find((iter: any) => {
          if (testCaseSnapshot && iter.testCaseSnapshot) {
            // Match by model and provider from snapshot
            return (
              iter.testCaseSnapshot.title === testCaseSnapshot.title &&
              iter.testCaseSnapshot.query === testCaseSnapshot.query &&
              iter.testCaseSnapshot.model === testCaseSnapshot.model &&
              iter.testCaseSnapshot.provider === testCaseSnapshot.provider &&
              iter.iterationNumber === iterationNumber
            );
          }
          // Fallback to matching by testCaseId and iteration number
          return (
            iter.testCaseId === testCaseId &&
            iter.iterationNumber === iterationNumber
          );
        });

        if (!matchingIteration) {
          logger.error(
            "[evals] Could not find pre-created iteration for",
            undefined,
            {
              testCaseId,
              testCaseSnapshot,
              iterationNumber,
            },
          );
          return undefined;
        }

        // Mark it as running
        await convexClient.mutation("testSuites:startTestIteration" as any, {
          iterationId: matchingIteration._id,
        });

        return matchingIteration._id as string;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Check if run was deleted/not found
        if (
          errorMessage.includes("not found") ||
          errorMessage.includes("unauthorized")
        ) {
          runDeleted = true;
          // Silently skip - run was likely cancelled/deleted
          return undefined;
        }

        logger.error(
          "[evals] Failed to record iteration start:",
          new Error(errorMessage),
        );
        return undefined;
      }
    },
    async finishIteration({
      iterationId,
      passed,
      toolsCalled,
      usage,
      messages,
      status,
      startedAt,
      error,
      errorDetails,
    }) {
      if (!iterationId || runDeleted) {
        return;
      }

      // Check if iteration was cancelled before trying to update
      try {
        const iteration = await convexClient.query(
          "testSuites:getTestIteration" as any,
          { iterationId },
        );
        if (iteration?.status === "cancelled") {
          logger.debug(
            "[evals] Skipping update for cancelled iteration:",
            iterationId,
          );
          return;
        }
      } catch (error) {
        // If we can't check status, continue anyway
      }

      const iterationStatus =
        status ?? (passed ? DEFAULT_ITERATION_STATUS : "failed");
      const result = passed ? "passed" : "failed";

      try {
        await convexClient.action("testSuites:updateTestIteration" as any, {
          iterationId,
          status:
            iterationStatus === "completed" ? "completed" : iterationStatus,
          result,
          actualToolCalls: toolsCalled,
          tokensUsed: usage.totalTokens ?? 0,
          messages,
          error,
          errorDetails,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Check if run was deleted/not found or iteration was cancelled
        if (
          errorMessage.includes("not found") ||
          errorMessage.includes("unauthorized") ||
          errorMessage.includes("cancelled")
        ) {
          runDeleted = true;
          // Silently skip - run was likely cancelled/deleted
          return;
        }

        logger.error(
          "[evals] Failed to record iteration result:",
          new Error(errorMessage),
        );
      }
    },
    async finalize({ status, summary, notes }) {
      if (runDeleted) {
        // Silently skip if run was deleted
        return;
      }

      try {
        await convexClient.mutation("testSuites:updateTestSuiteRun" as any, {
          runId,
          status,
          summary,
          notes,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);

        // Check if run was deleted/not found
        if (
          errorMessage.includes("not found") ||
          errorMessage.includes("unauthorized")
        ) {
          runDeleted = true;
          // Silently skip - run was likely cancelled/deleted
          return;
        }

        logger.error(
          "[evals] Failed to finalize suite run:",
          new Error(errorMessage),
        );
      }
    },
  };
};

export const startSuiteRunWithRecorder = async ({
  convexClient,
  suiteId,
  notes,
  passCriteria,
  serverIds,
}: {
  convexClient: ConvexHttpClient;
  suiteId: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  serverIds?: string[];
}) => {
  const response = await convexClient.mutation(
    "testSuites:startTestSuiteRun" as any,
    {
      suiteId,
      notes,
      passCriteria,
    },
  );

  const runId = response?.runId as string;
  const testCases = response?.testCases as Array<Record<string, any>>;

  if (!runId || !testCases) {
    throw new Error("Failed to start suite run");
  }

  // Pre-create all iterations
  await convexClient.mutation("testSuites:precreateIterationsForRun" as any, {
    runId,
  });

  const recorder = createSuiteRunRecorder({
    convexClient,
    suiteId,
    runId,
  });

  // Build config from test cases for backward compatibility
  const config = {
    tests: testCases.flatMap((tc: any) =>
      (tc.models || []).map((model: any) => ({
        title: tc.title,
        query: tc.query,
        model: model.model,
        provider: model.provider,
        runs: tc.runs || 1,
        expectedToolCalls: tc.expectedToolCalls || [],
        isNegativeTest: tc.isNegativeTest,
        advancedConfig: tc.advancedConfig,
        testCaseId: tc._id,
      })),
    ),
    environment: { servers: serverIds || [] },
  };

  return {
    runId,
    suiteId,
    config,
    recorder,
  };
};
