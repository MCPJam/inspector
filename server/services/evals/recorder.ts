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
      judgeRequirement?: string;
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
    async startIteration({ testCaseId, testCaseSnapshot, iterationNumber, startedAt }) {
      try {
        const response = await convexClient.mutation(
          "evals:recordSuiteIterationStart" as any,
          {
            suiteRunId: runId,
            testCaseId,
            testCaseSnapshot,
            iterationNumber,
            startedAt,
          },
        );
        return response?.iterationId as string | undefined;
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

      const iterationStatus = status ?? (passed ? DEFAULT_ITERATION_STATUS : "failed");
      const result = passed ? "passed" : "failed";

      try {
        await convexClient.action(
          "evals:recordSuiteIterationResult" as any,
          {
            suiteRunId: runId,
            iterationId,
            status: iterationStatus === "completed" ? "completed" : iterationStatus,
            result,
            actualToolCalls: toolsCalled,
            tokensUsed: usage.totalTokens ?? 0,
            messages,
            startedAt,
          },
        );
      } catch (error) {
        console.error(
          "[evals] Failed to record iteration result:",
          error instanceof Error ? error.message : error,
        );
      }
    },
    async finalize({ status, summary, notes }) {
      try {
        await convexClient.mutation("evals:finalizeSuiteRun" as any, {
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
}: {
  convexClient: ConvexHttpClient;
  suiteId: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
}) => {
  const response = await convexClient.mutation(
    "evals:startSuiteRun" as any,
    {
      suiteId,
      notes,
      passCriteria,
    },
  );

  const runId = response?.runId as string;
  const config = response?.config as {
    tests: Array<Record<string, any>>;
    environment: { servers: string[] };
  };

  if (!runId || !config) {
    throw new Error("Failed to start suite run");
  }

  const recorder = createSuiteRunRecorder({
    convexClient,
    suiteId,
    runId,
  });

  return {
    runId,
    suiteId,
    config,
    recorder,
  };
};


