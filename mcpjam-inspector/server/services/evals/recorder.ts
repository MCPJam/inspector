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
import {
  lockEvalSessionAfterUpdate,
  persistEvalTraceFanout,
} from "./persist-eval-trace.js";
import { resolveCaseSuccessPredicates } from "@/shared/eval-matching";

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
      startedAt,
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

      // PR-2 eval→chatSessions fanout: when the backend flag is on,
      // write the transcript as per-turn rows in the chatSessions path
      // BEFORE calling updateTestIteration. The fanout no longer fires
      // the terminal lock — that happens AFTER updateTestIteration
      // succeeds so a downstream iteration-row failure cannot leave a
      // locked transcript without a finalized iteration (PR-2 review
      // fix #2, Cursor #ed44ef40). Idempotent on retry.
      //
      // Fanout result drives whether we still pass trace fields to
      // updateTestIteration:
      //   - null            → flag off; today's legacy behavior runs
      //   - persisted:true  → trace lives in chatSessions; updateTestIteration
      //                       called WITHOUT trace fields (no double-persist)
      //   - persisted:false → fanout failed mid-stream; fall back to
      //                       the legacy single-call path so the iteration
      //                       is still complete and replayable.
      // lockReason describes the transcript LIFECYCLE (did the eval cycle
      // run to completion?), NOT the verdict. A failed-verdict iteration
      // that ran cleanly (status: "completed", result: "failed") still
      // gets eval_completed; eval_failed is reserved for cycle failures
      // like provider errors, MCP transport crashes, etc. The verdict
      // lives on testIteration.result (passed | failed | pending).
      //
      // The `error != null` check covers a runner quirk (Codex review on
      // #2446): the backend eval paths sometimes set
      // `iterationError` while still calling finishIteration with
      // `status: "completed"` (see evals-runner.ts:2079-2082 and
      // :3962-3965). Treating those as eval_completed would lock an
      // error transcript with the wrong reason. Presence of `error`
      // is the cycle-failure signal we already have in scope.
      //
      // Today this is defense-in-depth: the backend's
      // internalUpdateTestIteration auto-lock (W1) fires first with the
      // same status-based derivation, and internalLockEvalSession is
      // "first lock wins" — so this recorder-side lock call no-ops. But
      // if W1 ever doesn't run (iteration finalized without status
      // patches) the wrong `passed`-based reason would land.
      const isCycleFailure =
        iterationStatus === "failed" || (error !== undefined && error !== "");
      const terminalReason: "eval_completed" | "eval_failed" | "eval_cancelled" =
        iterationStatus === "cancelled"
          ? "eval_cancelled"
          : isCycleFailure
            ? "eval_failed"
            : "eval_completed";
      const fanout = await persistEvalTraceFanout({
        convexClient,
        iterationId,
        iterationStartedAt: startedAt,
        messages,
        spans,
        prompts,
        widgetSnapshots,
      });
      // Fall back to the W1 single-call path ONLY when the fanout failed
      // before any turn landed. With turns already written, re-sending
      // would overwrite turn 0 (W1 always writes at promptIndex: 0) and
      // orphan turns 1..N. See persist-eval-trace.ts for the contract.
      const useW1Fallback =
        fanout.persisted === false && fanout.turnsWritten === 0;
      if (fanout.persisted === false) {
        logger.warn(
          useW1Fallback
            ? "[evals] persistEvalTraceFanout failed before any turn landed; falling back to W1 single-call save"
            : "[evals] persistEvalTraceFanout failed mid-stream; iteration finalized without re-attempting (would orphan partial turns)",
          {
            iterationId,
            turnsWritten: fanout.turnsWritten,
            error: fanout.error.message,
          },
        );
      }

      // PR-2 review #5 (Cursor "Update failure after successful fanout"):
      // track whether the iteration is gone so we don't waste a lock
      // call on a deleted session, AND so the lock fires even when
      // the iteration update threw a transient error.
      let iterationGoneOrCancelled = false;
      try {
        await convexClient.action("testSuites:updateTestIteration" as any, {
          iterationId,
          status:
            iterationStatus === "completed" ? "completed" : iterationStatus,
          result,
          actualToolCalls: sanitizeForConvexTransport(toolsCalled),
          tokensUsed: usage.totalTokens ?? 0,
          ...(useW1Fallback
            ? {
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
          iterationGoneOrCancelled = true;
        } else {
          logger.error(
            "[evals] Failed to record iteration result:",
            new Error(errorMessage),
          );
          // Transient (non-cancellation) failure: fall through to the
          // lock step. The chatSessions transcript is complete from
          // the fanout's perspective; locking prevents a retry from
          // accumulating partial writes against a row whose data
          // already represents the final state. The iteration row's
          // terminal status remains stale until a retry/cron sweep
          // finalizes it — that's acceptable because the data is
          // consistent at the chatSessions layer.
        }
      }

      // Lock the chatSession when fanout succeeded — runs in BOTH the
      // success branch (updateTestIteration succeeded → defense + UI
      // hint) and the transient-failure branch (updateTestIteration
      // threw a non-cancellation error → prevents partial writes on
      // retry). Skipped only when the iteration is gone, where
      // locking a deleted session is wasted work. Best-effort:
      // lockEvalSessionAfterUpdate swallows its own failures.
      if (fanout?.persisted === true && !iterationGoneOrCancelled) {
        await lockEvalSessionAfterUpdate({
          convexClient,
          iterationId,
          reason: terminalReason,
        });
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
