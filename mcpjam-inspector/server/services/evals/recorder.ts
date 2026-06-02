import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PromptTraceSummary } from "@/shared/eval-trace";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import type { PromptTurn } from "@/shared/prompt-turns";
import type { UsageTotals } from "./types";
import { logger } from "../../utils/logger";
import type { ServerToolSnapshot } from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import { buildIterationUsageMetadata } from "./iteration-usage-metadata.js";
import { resolveCasePredicates } from "@/shared/eval-matching";

type IterationStatus = "completed" | "failed" | "cancelled";

type SuiteRunEnvironmentSnapshot = {
  servers: string[];
  serverBindings?: Array<{
    serverName: string;
    projectServerId?: string;
    workspaceServerId?: string;
  }>;
};

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
      expectedOutput?: string;
      promptTurns?: PromptTurn[];
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
    spans?: EvalTraceSpan[];
    prompts?: PromptTraceSummary[];
    widgetSnapshots?: EvalTraceWidgetSnapshot[];
    status?: IterationStatus;
    startedAt?: number;
    error?: string;
    errorDetails?: string;
    resultSource?: "reported" | "derived";
    // Scalar signals (argumentMismatchCount, host exposure counts, …) plus the
    // nested `predicates: PredicateResult[]` rows. Persisted to
    // `testIteration.metadata`; the Convex validator accepts nested values.
    metadata?: Record<string, unknown>;
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

function isSuiteRunEnvironmentSnapshot(
  value: unknown,
): value is SuiteRunEnvironmentSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const environment = value as SuiteRunEnvironmentSnapshot;
  return (
    Array.isArray(environment.servers) &&
    environment.servers.every((server) => typeof server === "string")
  );
}

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
      spans,
      prompts,
      widgetSnapshots,
      status,
      error,
      errorDetails,
      resultSource,
      metadata,
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
          actualToolCalls: sanitizeForConvexTransport(toolsCalled),
          tokensUsed: usage.totalTokens ?? 0,
          messages: sanitizeForConvexTransport(messages),
          ...(spans?.length
            ? { spans: sanitizeForConvexTransport(spans) }
            : {}),
          ...(prompts?.length
            ? { prompts: sanitizeForConvexTransport(prompts) }
            : {}),
          ...(widgetSnapshots?.length
            ? {
                widgetSnapshots:
                  sanitizeForConvexTransport(widgetSnapshots),
              }
            : {}),
          error,
          errorDetails,
          resultSource,
          // Merge user-provided metadata with token usage breakdown, then
          // sanitize: metadata can carry nested predicate rows whose authored
          // args may contain $-prefixed keys Convex rejects at the boundary.
          metadata: sanitizeForConvexTransport({
            ...(metadata ?? {}),
            ...buildIterationUsageMetadata(usage),
          }),
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
  replayedFromRunId,
  useCurrentSuiteConfig,
  environmentOverride,
  toolSnapshot,
  toolSnapshotDebug,
  iterationOverride,
  matchOptionsOverride,
  namedHostId,
  runGroupId,
}: {
  convexClient: ConvexHttpClient;
  suiteId: string;
  notes?: string;
  passCriteria?: {
    minimumPassRate: number;
  };
  serverIds?: string[];
  replayedFromRunId?: string;
  useCurrentSuiteConfig?: boolean;
  environmentOverride?: {
    servers: string[];
    serverBindings?: Array<{
      serverName: string;
      projectServerId?: string;
    }>;
  };
  toolSnapshot?: ServerToolSnapshot;
  toolSnapshotDebug?: Record<string, unknown>;
  /**
   * Transient per-run iteration count (1-10). Overlays `runs` on every
   * snapshotted test case via the `startTestSuiteRun` mutation; persisted
   * `testCase.runs` is untouched.
   */
  iterationOverride?: number;
  /**
   * One-off match-option override for this run only. Convex
   * `precreateIterationsForRun` resolves it on top of suite default +
   * case override into each iteration's `testCaseSnapshot.matchOptions`.
   */
  matchOptionsOverride?: import("@/shared/eval-matching").MatchOptionsDTO;
  /**
   * Scope this run to a single host attached to the suite. The Convex
   * mutation snapshots the host's current config and uses the snapshot's
   * server set as the run's environment. The runner is unchanged — it
   * just receives the host's servers like any other run.
   */
  namedHostId?: string;
  /**
   * Client-generated UUID shared by every per-host run when a multi-host
   * eval launch fans out. Persisted on `testSuiteRun.runGroupId` so the
   * UI can collapse sibling rows into a single group. Absent on
   * single-host launches.
   */
  runGroupId?: string;
}) => {
  const response = await convexClient.mutation(
    "testSuites:startTestSuiteRun" as any,
    {
      suiteId,
      notes,
      passCriteria,
      replayedFromRunId,
      useCurrentSuiteConfig,
      environmentOverride,
      toolSnapshot: sanitizeForConvexTransport(toolSnapshot),
      toolSnapshotDebug: sanitizeForConvexTransport(toolSnapshotDebug),
      iterationOverride,
      matchOptionsOverride,
      ...(namedHostId ? { namedHostId } : {}),
      ...(runGroupId ? { runGroupId } : {}),
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

  // Use the full environment Convex snapshotted into the run (derived
  // from suite.hostConfigId.serverIds when available, else the legacy
  // suite environment). `environment.servers` is a display/compat list;
  // serverBindings carries the stable id mapping resolveConfiguredServerIds
  // needs before calling getToolsForAiSdk. Falling back to the raw request
  // refs is only for older backend responses without configSnapshot.
  const snapshotEnvironment = isSuiteRunEnvironmentSnapshot(
    (response?.configSnapshot as any)?.environment,
  )
    ? ((response?.configSnapshot as any)
        .environment as SuiteRunEnvironmentSnapshot)
    : { servers: serverIds ?? [] };

  // Resolve suite default predicates once so per-case envelopes can be
  // collapsed to a flat list for the runner. Prefer the configSnapshot when
  // present (mirrors how Convex freezes other suite defaults onto the run),
  // fall back to a live suite query, then to undefined.
  let suiteDefaultPredicates =
    ((response?.configSnapshot as any)?.defaultPredicates as
      | import("@/shared/eval-matching").Predicate[]
      | undefined) ?? undefined;
  if (!Array.isArray(suiteDefaultPredicates) || suiteDefaultPredicates.length === 0) {
    try {
      const suite = await convexClient.query(
        "testSuites:getTestSuite" as any,
        { suiteId },
      );
      const defaults = (suite as { defaultPredicates?: unknown } | undefined)
        ?.defaultPredicates;
      suiteDefaultPredicates = Array.isArray(defaults) && defaults.length > 0
        ? (defaults as import("@/shared/eval-matching").Predicate[])
        : undefined;
    } catch {
      suiteDefaultPredicates = undefined;
    }
  } else if (suiteDefaultPredicates.length === 0) {
    suiteDefaultPredicates = undefined;
  }

  const resolvePredicatesForCase = (
    tc: Record<string, any>,
  ): import("@/shared/eval-matching").Predicate[] | undefined => {
    const envelope = tc.predicates as
      | import("@/shared/eval-matching").CasePredicates
      | undefined;
    const resolved = resolveCasePredicates(suiteDefaultPredicates, envelope);
    if (resolved && resolved.length > 0) return resolved;
    // Legacy flat field on the persisted case — fallback when no envelope.
    const legacy = tc.successPredicates;
    return Array.isArray(legacy) && legacy.length > 0
      ? (legacy as import("@/shared/eval-matching").Predicate[])
      : undefined;
  };

  // Build config from test cases for backward compatibility
  const config = {
    tests: testCases.flatMap((tc: any) => {
      const successPredicates = resolvePredicatesForCase(tc);
      if (Array.isArray(tc.models) && tc.models.length > 0) {
        return tc.models.map((model: any) => ({
          title: tc.title,
          query: tc.query,
          model: model.model,
          provider: model.provider,
          runs: tc.runs || 1,
          expectedToolCalls: tc.expectedToolCalls || [],
          isNegativeTest: tc.isNegativeTest,
          expectedOutput: tc.expectedOutput,
          promptTurns: tc.promptTurns,
          advancedConfig: tc.advancedConfig,
          matchOptions: tc.matchOptions,
          successPredicates,
          testCaseId: tc._id,
        }));
      }

      if (tc.model && tc.provider) {
        return [
          {
            title: tc.title,
            query: tc.query,
            model: tc.model,
            provider: tc.provider,
            runs: tc.runs || 1,
            expectedToolCalls: tc.expectedToolCalls || [],
            isNegativeTest: tc.isNegativeTest,
            expectedOutput: tc.expectedOutput,
            promptTurns: tc.promptTurns,
            advancedConfig: tc.advancedConfig,
            matchOptions: tc.matchOptions,
            successPredicates,
            testCaseId: tc.testCaseId ?? tc._id,
          },
        ];
      }

      return [];
    }),
    environment: snapshotEnvironment,
  };

  return {
    runId,
    suiteId,
    config,
    recorder,
    hostConfig: response?.hostConfig as
      | Record<string, unknown>
      | null
      | undefined,
  };
};
