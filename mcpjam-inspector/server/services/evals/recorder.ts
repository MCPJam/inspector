import type { ModelMessage } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { PromptTraceSummary } from "@/shared/eval-trace";
import type { EvalTraceWidgetSnapshot } from "@/shared/eval-trace";
import type {
  RunnerBrowserInteractionStep,
  RunnerWidgetRenderObservation,
} from "@/shared/eval-trace";
import { isModelFree, type PromptTurn, type TestStep } from "@/shared/steps";
import type { UsageTotals } from "./types";
import { logger } from "../../utils/logger";
import type { ServerToolSnapshot } from "../../utils/export-helpers.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";
import type { RunPinnedPluginVersion } from "./run-plugin-snapshot.js";
import { finalizeEvalIteration } from "./finalize-iteration.js";
import { forgetShadowMismatchRun } from "./shadow-mismatch.js";
import { RUNNER_CAPABILITIES } from "./runner-capabilities.js";
import type { IterationStatus as ContractIterationStatus } from "@mcpjam/sdk/contract";
import { resolveCaseSuccessPredicates } from "@/shared/eval-matching";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { ConvexError } from "convex/values";
import {
  environmentLaunchConflictError,
  environmentLaunchRejectionError,
  environmentModelRequiredError,
  isEnvironmentLaunchConflict,
} from "../environments/resolve.js";

/**
 * The canonical lifecycle vocabulary — `setup_failed` and `skipped` included.
 * The recorder is a pass-through to {@link finalizeEvalIteration}, so a
 * narrower union here would silently reject the classification a runner made.
 */
type IterationStatus = ContractIterationStatus;
// Run-level (not per-iteration) terminal stop reason, threaded into the
// suite-run finalize so the dashboard can show why a run stopped.
type RunStopReason = "user_cancelled" | "run_timeout" | "iteration_timeout";

/**
 * When a Convex mutation rejects because a billing/entitlement cap was hit
 * (e.g. `maxEvalIterationsPerMonth`), the structured payload lives on
 * `ConvexError.data`. Re-emit it as a 402 `WebRouteError` carrying that exact
 * payload in `details`, so the route serializes it onto the JSON body and the
 * client can rebuild a ConvexError and render the proper upgrade message —
 * instead of collapsing it into a generic 500 where the billing fields are
 * lost. Returns null for any non-billing error so callers fall through to
 * their normal handling.
 */
function asBillingRouteError(error: unknown): WebRouteError | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data = error.data as { code?: unknown; message?: unknown } | undefined;
  if (
    !data ||
    typeof data !== "object" ||
    (data.code !== "billing_limit_reached" &&
      data.code !== "billing_feature_not_included")
  ) {
    return null;
  }
  const message =
    typeof data.message === "string" && data.message.length > 0
      ? data.message
      : "Your plan limit was reached.";
  return new WebRouteError(
    402,
    ErrorCode.BILLING_LIMIT_REACHED,
    message,
    data as Record<string, unknown>
  );
}

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
      steps?: TestStep[];
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
    /** Effective model used by the iteration; persisted on the eval session. */
    modelId?: string;
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
    /**
     * Iteration replay `.webm` bytes. Pure pass-through to
     * `finalizeEvalIteration`, which uploads it (best-effort) alongside the
     * screenshots.
     */
    videoBytes?: Buffer | null;
    /** Explicit harness lifecycle status; never infer it from the verdict. */
    status: IterationStatus;
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
  value: unknown
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
    async startIteration({ testCaseId, testCaseSnapshot, iterationNumber }) {
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
          { runId }
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
            }
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
          new Error(errorMessage)
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
      // Drop this run's shadow-mismatch bookkeeping FIRST, and unconditionally.
      //
      // `shadow-mismatch.ts` keeps a per-run dedupe set so one comparison is
      // reported once rather than once per iteration; without a matching
      // forget, that map is a leak that grows for the life of the process —
      // one entry per run, one entry per (iteration, kind) inside it. It was
      // harmless while no cohort produced score rows and stops being harmless
      // the moment the observation window raises the volume, which is why the
      // fix lands BEFORE the window rather than after someone notices.
      //
      // Before the early return, because a deleted run still had comparisons
      // recorded against it, and in a `finally` because a failed finalize is
      // exactly when the entry would otherwise be stranded.
      try {
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
            new Error(errorMessage)
          );
        }
      } finally {
        forgetShadowMismatchRun(runId);
      }
    },
  };
};

// `RUNNER_CAPABILITIES` moved to `./runner-capabilities.ts` when the pre-run
// disclosure route (G4c) became its second caller — see that module's header
// for why both callers must send the identical list, and why a route must not
// import this one to get it.

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
  caseIds,
  matchOptionsOverride,
  namedHostId,
  runGroupId,
  environmentId,
  expectedEnvironmentRevision,
  expectedEnvironmentHostConfigId,
  expectedEnvironmentServerIds,
  source,
  idempotencyKey,
  sourceHash,
  skillsOverride,
  ephemeralEnvironment,
  importApprovals,
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
    // Reproducible-env pin, forwarded from getRunReplayMetadata on a
    // current-config replay so the replay keeps the source run's frozen
    // computer environment (must be declared here or a reconstruction of this
    // object would silently drop it before Convex).
    computerEnvironmentId?: string;
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
   * Run-only case subset. When set, the `startTestSuiteRun` mutation narrows
   * the run's snapshot to just these suite cases; precreate + the runner are
   * unchanged. Used by single-case runs from the public API / CLI.
   */
  caseIds?: string[];
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
   * Project-environment launch: the environment this run resolves and
   * pins. Threaded into `startTestSuiteRun` (which snapshots
   * `configSnapshot.environmentRef`). Must be declared here or a
   * reconstruction of the mutation args would silently drop it.
   */
  environmentId?: string;
  /**
   * The environment revision `prepareEvalRun` resolved (and captured the
   * tool snapshot against). The mutation compares it to the environment's
   * current revision BEFORE inserting any run row and rejects a mismatch
   * with structured conflict data — see `services/environments/resolve.ts`.
   */
  expectedEnvironmentRevision?: number;
  /**
   * The host config the environment resolved to. The revision alone does NOT
   * make a launch atomic: an environment pins a `hostId`, and the host can
   * rotate its config (`hosts:updateHost`) without touching the environment
   * row. Echoing it lets the mutation reject that drift (`ENV_HOST_DRIFT`).
   */
  expectedEnvironmentHostConfigId?: string;
  /**
   * The environment's effective (non-plugin + plugin-contributed) server set
   * at resolve time. Same reason as the host config: editing the pinned
   * standalone attachment changes what the environment resolves to at an
   * unchanged revision. Must be the STORED closed set, not the live-healed
   * projection — the backend re-derives the stored set to compare.
   */
  expectedEnvironmentServerIds?: string[];
  /**
   * Run origin persisted on `testSuiteRun.source` for audit attribution.
   * Omitted means 'ui' (backend default); the public /api/v1 surface
   * passes 'api'; the scheduled-evals worker passes 'schedule'; the
   * GitHub-checks worker passes 'github_check'.
   */
  source?: "ui" | "api" | "schedule" | "github_check";
  /**
   * Forwarded to `startTestSuiteRun.idempotencyKey` so retried triggers
   * (scheduled-run claim retries) can never double-create a run. Absent on
   * interactive paths — the mutation's fingerprint window covers those.
   */
  idempotencyKey?: string;
  /**
   * SHA-256 hex of the suite-file bytes that launched this run. Forwarded to
   * Convex `startTestSuiteRun.sourceHash` so a file-owned run records the
   * exact bytes it ran.
   */
  sourceHash?: string;
  /**
   * The A/B "without skills" arm. `'exclude'` tells `startTestSuiteRun` to pin
   * NO skills from any channel and to mark the run `skillsExcluded`, so the
   * comparison arm is labelled rather than merely empty. See the wire schema
   * for the deliberate plugin-servers asymmetry.
   */
  skillsOverride?: "exclude";
  /**
   * Compose-and-run: accept a project-scoped, non-archived environment that
   * is not a suite member. Forwarded to `startTestSuiteRun`.
   */
  ephemeralEnvironment?: boolean;
  /**
   * Per-run approval of `approximated` imported cases, by hosted test-case id.
   *
   * Forwarded to `startTestSuiteRun.importApprovals`, which validates them
   * against the cases this run will actually execute, derives the approver
   * from the authenticated launcher, stamps the time, and freezes the
   * resulting decision into the run's own case snapshot. Nothing here is
   * persisted on the case: a later run needs a new approval.
   *
   * Must be declared here or a reconstruction of the mutation args would
   * silently drop it — and a dropped approval surfaces to the caller as the
   * backend refusing a run they did approve.
   */
  importApprovals?: Array<{ testCaseId: string; reason: string }>;
}) => {
  let response: any;
  try {
    response = await convexClient.mutation(
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
        ...(caseIds && caseIds.length ? { caseIds } : {}),
        matchOptionsOverride,
        ...(namedHostId ? { namedHostId } : {}),
        ...(runGroupId ? { runGroupId } : {}),
        ...(environmentId ? { environmentId } : {}),
        ...(expectedEnvironmentRevision !== undefined
          ? { expectedEnvironmentRevision }
          : {}),
        ...(expectedEnvironmentHostConfigId !== undefined
          ? { expectedEnvironmentHostConfigId }
          : {}),
        ...(expectedEnvironmentServerIds !== undefined
          ? { expectedEnvironmentServerIds }
          : {}),
        ...(source ? { source } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(sourceHash ? { sourceHash } : {}),
        ...(skillsOverride ? { skillsOverride } : {}),
        ...(ephemeralEnvironment === true ? { ephemeralEnvironment: true } : {}),
        ...(importApprovals && importApprovals.length
          ? { importApprovals }
          : {}),
        runnerCapabilities: RUNNER_CAPABILITIES,
      }
    );
  } catch (error) {
    // The eval-iteration cap is checked fail-fast inside startTestSuiteRun
    // (before any run row is created), so an out-of-quota launch rejects here
    // with the billing ConvexError and NO pending run group is stranded.
    const billing = asBillingRouteError(error);
    if (billing) {
      throw billing;
    }
    // The environment resolves to no model — no override on it, none pinned on
    // its client — so the backend refused before creating anything. Remediable
    // and specific, so it gets its own 409 rather than surfacing as an opaque
    // Convex rejection. NOT gated on the drift echoes below: this refusal is a
    // property of the environment itself, not of a precondition we sent.
    const modelRequired = environmentModelRequiredError(error);
    if (modelRequired) {
      throw modelRequired;
    }
    // The environment changed between prepareEvalRun's resolution and the
    // run-start mutation — either its revision moved, or it resolved
    // differently at an unchanged revision (host config rotated / pinned
    // attachment edited). Either way no run row exists. Interactive callers
    // surface the readable 409; the scheduled worker's trigger/idempotency
    // path retries naturally.
    //
    // Gate on any echo being present, not just the revision: a launch that
    // sent only the drift echoes still needs its conflict translated.
    if (
      (expectedEnvironmentRevision !== undefined ||
        expectedEnvironmentHostConfigId !== undefined ||
        expectedEnvironmentServerIds !== undefined) &&
      isEnvironmentLaunchConflict(error)
    ) {
      throw environmentLaunchConflictError(error);
    }
    // The remaining structured refusals — a bad ephemeralEnvironment request,
    // a non-member or ambiguous environment, the resolver's cross-project /
    // archived / missing verdicts. Each aborts BEFORE any run row exists, and
    // each names something the caller can act on; rethrowing raw handed them
    // all to the generic handler as `500 "Server Error"`, which is what the
    // backend raising ConvexError instead of Error was meant to prevent.
    // Returns null for anything unrecognized, so a real fault stays a 500.
    const rejection = environmentLaunchRejectionError(error);
    if (rejection) {
      throw rejection;
    }
    throw error;
  }

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
    logger.error("[evals] Failed to pre-create suite run iterations", error, {
      suiteId,
      runId,
    });
    try {
      await convexClient.mutation(
        "testSuites:markSetupPendingIterationsFailed" as any,
        { runId, error: cause }
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
      notes: "Failed to prepare eval test attempts.",
    });
    // Defense in depth: the run-start pre-check normally rejects out-of-quota
    // launches before the run row exists, but a launch that races another to
    // exhaust the cap can still trip the reserve here. Preserve the billing
    // payload so the client renders the proper upgrade message; the run was
    // already finalized failed above, so no pending group is left behind.
    const billing = asBillingRouteError(error);
    if (billing) {
      throw billing;
    }
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Could not start eval because MCPJam failed to prepare the test attempts. Try again.",
      { runId, cause }
    );
  }

  // Use the full environment Convex snapshotted into the run (derived
  // from suite.hostConfigId.serverIds when available, else the legacy
  // suite environment). `environment.servers` is a display/compat list;
  // serverBindings carries the stable id mapping resolveConfiguredServerIds
  // needs before calling getToolsForAiSdk. Falling back to the raw request
  // refs is only for older backend responses without configSnapshot.
  const snapshotEnvironment = isSuiteRunEnvironmentSnapshot(
    (response?.configSnapshot as any)?.environment
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
  let suiteDefaultPredicates:
    | import("@/shared/eval-matching").Predicate[]
    | undefined;
  if (Array.isArray(snapshotDefaults)) {
    suiteDefaultPredicates =
      snapshotDefaults.length > 0
        ? (snapshotDefaults as import("@/shared/eval-matching").Predicate[])
        : undefined;
  } else {
    try {
      const suite = await convexClient.query("testSuites:getTestSuite" as any, {
        suiteId,
      });
      const defaults = (suite as { defaultPredicates?: unknown } | undefined)
        ?.defaultPredicates;
      suiteDefaultPredicates =
        Array.isArray(defaults) && defaults.length > 0
          ? (defaults as import("@/shared/eval-matching").Predicate[])
          : undefined;
    } catch {
      suiteDefaultPredicates = undefined;
    }
  }

  const resolvePredicatesForCase = (
    tc: Record<string, any>
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
      // Model-free step cases have no persisted models. Emit one sentinel row so
      // the runner executes and pairs the pre-created iteration by testCaseId.
      if (isModelFree(tc.steps)) {
        return [
          {
            title: tc.title,
            query: tc.query ?? "",
            model: "widget-probe",
            provider: "none",
            runs: tc.runs || 1,
            expectedToolCalls: [],
            isNegativeTest: tc.isNegativeTest,
            expectedOutput: tc.expectedOutput,
            steps: tc.steps,
            advancedConfig: tc.advancedConfig,
            matchOptions: tc.matchOptions,
            successPredicates,
            testCaseId: tc._id ?? tc.testCaseId,
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
          steps: tc.steps,
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
            steps: tc.steps,
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
    /**
     * This start was a REPLAY of an existing run (idempotency key hit, or the
     * keyless fingerprint window), not a launch.
     *
     * Absent from a backend that predates the field, which callers must read
     * as "unknown", NOT as "fresh": treating an old backend's silence as a
     * launch is exactly the assumption that had retries re-running a finished
     * suite. Skew therefore keeps the old behaviour rather than gaining the
     * new refusal.
     */
    deduped: response?.deduped as boolean | undefined,
    /** The run's status as the platform holds it — `completed` on a replay of
     *  a finished run, not the `running` a launch would report. */
    status: response?.status as string | undefined,
    hostConfig: response?.hostConfig as
      | Record<string, unknown>
      | null
      | undefined,
    /**
     * `configSnapshot.environmentPluginVersions` (BE-5) — identity +
     * `bundleHash` of every plugin version this run pinned, in pin order.
     *
     * Surfaced from the RUN row rather than re-read from the environment
     * resolution that preceded it. The two agree by construction (the mutation
     * rejects any drift between them via the `expectedEnvironment*` echoes),
     * but only one of them is the run's own immutable record, and provenance
     * that is displayed and reported should come from the record. Absent on a
     * legacy run, a plugin-free environment, or an older backend.
     */
    pluginVersions: (response?.configSnapshot as any)
      ?.environmentPluginVersions as RunPinnedPluginVersion[] | undefined,
    /**
     * The run's FROZEN grading-engine position, straight off its own snapshot.
     *
     * Read from the RUN row rather than re-resolved from the suite or a flag,
     * for the same reason `pluginVersions` is: the run's immutable record is
     * what every other reader (the judge second pass, all three backend write
     * boundaries) consults, and a runner that resolved its own position could
     * grade the first pass under a mode the rest of the pipeline disagrees
     * with. Absent on a legacy run, an `off` run, or an older backend — all of
     * which mean the same thing here.
     */
    gradingEngine: (response?.configSnapshot as any)?.gradingEngine as
      | { mode?: unknown }
      | undefined,
  };
};
