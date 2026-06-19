import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PromptTraceSummary } from "@/shared/eval-trace";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import type {
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import type { PromptTurn } from "@/shared/prompt-turns";
import type { UsageTotals } from "./types";
import { logger } from "../../utils/logger";
import type { ServerToolSnapshot } from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import { finalizeEvalIteration } from "./finalize-iteration.js";
import { resolveCaseSuccessPredicates } from "@/shared/eval-matching";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

type IterationStatus = "completed" | "failed" | "cancelled" | "timed_out";
type RunStopReason = "user_cancelled" | "run_timeout" | "iteration_timeout";

type SuiteRunEnvironmentSnapshot = {
  servers: string[];
  serverBindings?: Array<{
    serverName: string;
    projectServerId?: string;
    workspaceServerId?: string;
  }>;
};

type BillingLimitPayload = {
  code?: string;
  message?: string;
  limit?: string;
  limitName?: string;
  allowedValue?: number | null;
  resetsAt?: number | null;
};

function tryParseJsonPayload(value: string): BillingLimitPayload | null {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as BillingLimitPayload;
    }
  } catch {
    // Convex often prefixes errors before appending the JSON payload.
  }

  const jsonMatch = value.match(/\{[\s\S]*\}$/);
  if (!jsonMatch) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed && typeof parsed === "object"
      ? (parsed as BillingLimitPayload)
      : null;
  } catch {
    return null;
  }
}

function extractBillingLimitPayload(error: unknown): BillingLimitPayload | null {
  const data = (error as { data?: unknown } | null | undefined)?.data;
  if (data && typeof data === "object") {
    return data as BillingLimitPayload;
  }
  if (typeof data === "string") {
    return tryParseJsonPayload(data);
  }

  if (error instanceof Error) {
    return tryParseJsonPayload(error.message);
  }
  if (typeof error === "string") {
    return tryParseJsonPayload(error);
  }
  return null;
}

function formatEvalBillingLimitMessage(
  payload: BillingLimitPayload | null,
): string | null {
  if (!payload || payload.code !== "billing_limit_reached") {
    return null;
  }

  const limitName = payload.limitName ?? payload.limit;
  if (
    limitName !== "maxEvalIterationsPerMonth" &&
    limitName !== "maxEvalRunsPerMonth"
  ) {
    return payload.message ?? null;
  }

  const allowedValue =
    typeof payload.allowedValue === "number" ? payload.allowedValue : null;
  const cap = allowedValue !== null ? ` (${allowedValue})` : "";
  const noun =
    limitName === "maxEvalRunsPerMonth"
      ? "monthly eval run limit"
      : "eval iteration limit";
  const reset =
    typeof payload.resetsAt === "number" && Number.isFinite(payload.resetsAt)
      ? ` Resets ${new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(payload.resetsAt))}.`
      : " Upgrade to continue.";

  return `This organization has reached its ${noun}${cap}.${reset}`;
}

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
    /**
     * Resolved system prompt for the eval session. Forwarded to
     * `persistEvalTraceFanout` → `appendEvalTurnTrace.systemPrompt`,
     * which the backend persists to `chatSessions.systemPrompt` with
     * first-write-wins semantics. Replaces the persistence-side
     * `{role:"system", ...}` prepend each runner used to splice into
     * `messages`.
     */
    systemPrompt?: string;
    /**
     * PR 6b: browser-rendered MCP App eval artifacts (runner-local shape).
     * Pure pass-through — `finishIteration` forwards them to
     * `finalizeEvalIteration`, which owns screenshot upload + serialization.
     */
    widgetRenderObservations?: RunnerWidgetRenderObservation[];
    browserInteractionSteps?: RunnerBrowserInteractionStep[];
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
    status: "completed" | "failed" | "cancelled" | "timed_out";
    summary?: {
      total: number;
      passed: number;
      failed: number;
      passRate: number;
    };
    notes?: string;
    stopReason?: RunStopReason;
  }): Promise<void>;
};

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
    async finishIteration(params) {
      if (runDeleted) {
        return;
      }
      await finalizeEvalIteration({
        convexClient,
        ...params,
        // Suite-run-scoped short-circuit: flip the recorder's
        // `runDeleted` flag when the shared finalize step sees a
        // "not found" / "unauthorized" / "cancelled" update error so
        // subsequent calls on this recorder no-op. The quick-run
        // direct path (no recorder) passes no callback.
        onRunDeleted: () => {
          runDeleted = true;
        },
      });
    },
    async finalize({ status, summary, notes, stopReason }) {
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
          stopReason,
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
  source,
  idempotencyKey,
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
  /**
   * Run origin persisted on `testSuiteRun.source` for audit attribution.
   * Omitted means 'ui' (backend default); the public /api/v1 surface
   * passes 'api'; the scheduled-evals worker passes 'schedule'.
   */
  source?: "ui" | "api" | "schedule";
  /**
   * Forwarded to `startTestSuiteRun.idempotencyKey` so retried triggers
   * (scheduled-run claim retries) can never double-create a run. Absent on
   * interactive paths — the mutation's fingerprint window covers those.
   */
  idempotencyKey?: string;
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
      ...(source ? { source } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  );

  const runId = response?.runId as string;
  const testCases = response?.testCases as Array<Record<string, any>>;

  if (!runId || !testCases) {
    throw new Error("Failed to start suite run");
  }

  const recorder = createSuiteRunRecorder({
    convexClient,
    suiteId,
    runId,
  });

  // Pre-create all iterations
  try {
    await convexClient.mutation("testSuites:precreateIterationsForRun" as any, {
      runId,
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const billingLimitMessage = formatEvalBillingLimitMessage(
      extractBillingLimitPayload(error),
    );
    logger.error("[evals] Failed to pre-create suite run iterations", error, {
      suiteId,
      runId,
    });
    try {
      await convexClient.mutation(
        "testSuites:markSetupPendingIterationsFailed" as any,
        { runId, error: cause },
      );
    } catch (cleanupError) {
      logger.warn("[evals] Failed to mark setup iterations failed", {
        suiteId,
        runId,
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      });
    }
    await recorder.finalize({
      status: "failed",
      notes: billingLimitMessage ?? "Failed to prepare eval test attempts.",
    });
    if (billingLimitMessage) {
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, billingLimitMessage, {
        runId,
        cause,
      });
    }
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Could not start eval because MCPJam failed to prepare the test attempts. Try again.",
      { runId, cause },
    );
  }

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
  // present (mirrors how Convex freezes other suite defaults onto the run);
  // an intentionally empty snapshot (`[]`) means "this run was frozen with
  // no suite defaults" and must NOT fall back to the live suite, otherwise
  // suite defaults added after run-precreate retroactively gate frozen
  // cases. Only the absent-or-non-array case falls back to a live query.
  const snapshotDefaults = (response?.configSnapshot as any)?.defaultPredicates;
  let suiteDefaultPredicates: import("@/shared/eval-matching").Predicate[] | undefined;
  if (Array.isArray(snapshotDefaults)) {
    suiteDefaultPredicates = snapshotDefaults.length > 0
      ? (snapshotDefaults as import("@/shared/eval-matching").Predicate[])
      : undefined;
  } else {
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
  }

  const resolvePredicatesForCase = (
    tc: Record<string, any>,
  ): import("@/shared/eval-matching").Predicate[] | undefined =>
    resolveCaseSuccessPredicates({
      suiteDefaults: suiteDefaultPredicates,
      envelope: tc.predicates as
        | import("@/shared/eval-matching").CasePredicates
        | undefined,
      legacyCase: tc.successPredicates as
        | import("@/shared/eval-matching").Predicate[]
        | undefined,
    });

  // Build config from test cases for backward compatibility
  const config = {
    tests: testCases.flatMap((tc: any) => {
      const successPredicates = resolvePredicatesForCase(tc);
      // Widget probes have no models — without this branch the model
      // fan-out below would silently drop them from the run. The sentinel
      // model/provider strings are display-only; the runner forks off the
      // LLM path before any model resolution.
      if (tc.caseType === "widget_probe" && !tc.probeConfig) {
        // Malformed probe (caseType without a pinned call): the model-free
        // fallthrough below would drop it without a trace — surface it.
        logger.warn("[evals] widget probe case missing probeConfig; skipped", {
          testCaseId: tc._id ?? tc.testCaseId,
          title: tc.title,
        });
        return [];
      }
      if (tc.caseType === "widget_probe" && tc.probeConfig) {
        return [
          {
            title: tc.title,
            query: "",
            model: "widget-probe",
            provider: "none",
            runs: tc.runs || 1,
            expectedToolCalls: [],
            successPredicates,
            testCaseId: tc._id ?? tc.testCaseId,
            caseType: "widget_probe" as const,
            probeConfig: tc.probeConfig,
          },
        ];
      }
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
