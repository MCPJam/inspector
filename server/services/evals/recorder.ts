import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { UsageTotals } from "./types";

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
      expectedToolCalls: string[];
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
  return {
    runId,
    suiteId,
    async startIteration({
      testCaseId,
      testCaseSnapshot,
      iterationNumber,
      startedAt,
    }) {
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
          console.error("[evals] Could not find pre-created iteration for", {
            testCaseId,
            testCaseSnapshot,
            iterationNumber,
          });
          return undefined;
        }

        // Mark it as running
        await convexClient.mutation("testSuites:startTestIteration" as any, {
          iterationId: matchingIteration._id,
        });

        return matchingIteration._id as string;
      } catch (error) {
        console.error(
          "[evals] Failed to record iteration start:",
          error instanceof Error ? error.message : error,
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
    }) {
      if (!iterationId) {
        return;
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
        });
      } catch (error) {
        console.error(
          "[evals] Failed to record iteration result:",
          error instanceof Error ? error.message : error,
        );
      }
    },
    async finalize({ status, summary, notes }) {
      try {
        await convexClient.mutation("testSuites:updateTestSuiteRun" as any, {
          runId,
          status,
          summary,
          notes,
        });
      } catch (error) {
        console.error(
          "[evals] Failed to finalize suite run:",
          error instanceof Error ? error.message : error,
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
