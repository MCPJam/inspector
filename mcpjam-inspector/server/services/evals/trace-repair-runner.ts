import type { ConvexHttpClient } from "convex/browser";
import {
  buildRefinementVerificationPlan,
  type RefinementVerificationPlanStep,
} from "../../../shared/refinement-verification-plan.js";
import { isMCPJamProvidedModel } from "../../../shared/types.js";
import { runEvalTestCaseWithManager } from "../../routes/shared/evals.js";
import { logger } from "../../utils/logger.js";
import {
  buildReplayManager,
  captureToolSnapshotForEvalAuthoring,
  connectReplayManagerServers,
  fetchReplayConfig,
} from "./route-helpers.js";
import { executeSuiteReplayFromRun } from "./replay-suite-run.js";
import { sanitizeForConvexTransport } from "./convex-sanitize.js";

const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const POLL_MS_INITIAL = 500;
const POLL_MS_MAX = 2000;
const CANDIDATE_TIMEOUT_MS = 45_000;
const REFINEMENT_CASE_CONCURRENCY_MAX = 5;
const REFINEMENT_CASE_CONCURRENCY_DEFAULT = 2;

/** @internal Exported for unit tests. */
export function parseRefinementCaseConcurrency(raw: string | undefined): number {
  if (raw == null || raw === "") {
    return REFINEMENT_CASE_CONCURRENCY_DEFAULT;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return REFINEMENT_CASE_CONCURRENCY_DEFAULT;
  }
  return Math.min(REFINEMENT_CASE_CONCURRENCY_MAX, n);
}

/**
 * Run `fn` over `items` with at most `limit` concurrent executions (order of completion may differ).
 * @internal Exported for unit tests.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results: R[] = new Array(items.length);
  const capped = Math.max(1, Math.min(limit, items.length));
  let nextIndex = 0;

  const worker = async () => {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: capped }, () => worker()));
  return results;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Never throws; disconnect failures are logged only (avoids masking real errors / unhandled rejections). */
async function safeDisconnectReplayManager(
  manager: ReturnType<typeof buildReplayManager>,
  context: string,
): Promise<void> {
  try {
    await manager.disconnectAllServers();
  } catch (err) {
    logger.warn("[trace-repair] disconnect failed (non-fatal)", {
      context,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function normalizeProviderKey(provider: string): string | null {
  const normalized = provider.toLowerCase().replace(/[^a-z]/g, "");
  switch (normalized) {
    case "anthropic":
    case "azure":
    case "openai":
    case "deepseek":
    case "google":
    case "mistral":
    case "xai":
    case "ollama":
    case "openrouter":
      return normalized;
    default:
      return null;
  }
}

function resolveModelApiKeys(
  provider: string,
  model: string,
  modelApiKeys: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (isMCPJamProvidedModel(model)) {
    return undefined;
  }
  const normalized = normalizeProviderKey(provider);
  const raw =
    modelApiKeys?.[provider] ??
    (normalized ? modelApiKeys?.[normalized] : undefined);
  if (!raw) {
    return undefined;
  }
  return { [provider]: raw };
}

function collectSuiteModels(
  testCases: Array<{ models?: Array<{ model: string; provider: string }> }>,
): Array<{ model: string; provider: string }> {
  const map = new Map<string, { model: string; provider: string }>();
  for (const tc of testCases ?? []) {
    for (const m of tc.models ?? []) {
      const k = `${m.provider}:${m.model}`;
      if (!map.has(k)) {
        map.set(k, m);
      }
    }
  }
  return [...map.values()];
}

type FailedCase = {
  sourceIterationId: string;
  testCaseId?: string;
  caseKey: string;
};

type TraceRepairSessionSnapshot = {
  status?: string;
  candidateRevisionId?: string | null;
  traceRepairDebug?: {
    generation?: {
      errorMessage?: string;
      parseStage?: string;
    };
  };
} | null;

type TraceRepairCaseResult = {
  promoted: boolean;
  serverLikely: boolean;
  generationFailedOnly: boolean;
};

/** @internal exported for unit tests */
export function signatureFromFailedTraceRepairAttempt(
  verificationRuns: Array<{
    label: string;
    passed: boolean;
    failureSignature?: string;
  }>,
  orderedLabels?: string[],
): string {
  const order =
    orderedLabels && orderedLabels.length > 0
      ? orderedLabels
      : ["same-model-1", "same-model-2"];
  for (const label of order) {
    const run = verificationRuns.find((r) => r.label === label);
    if (run && !run.passed) {
      return (run.failureSignature ?? "").trim();
    }
  }
  return "";
}

/** @internal exported for unit tests */
export function failedQuickIterationId(
  verificationRuns: Array<{
    label: string;
    passed: boolean;
    iterationId?: string;
  }>,
  orderedLabels?: string[],
): string | undefined {
  const order =
    orderedLabels && orderedLabels.length > 0
      ? orderedLabels
      : ["same-model-1", "same-model-2"];
  for (const label of order) {
    const run = verificationRuns.find((r) => r.label === label);
    if (run && !run.passed && run.iterationId) {
      return run.iterationId as string;
    }
  }
  return undefined;
}

/** @internal exported for unit tests */
export function isTraceRepairGenerationFailureSession(
  session: TraceRepairSessionSnapshot,
): boolean {
  if (!session || session.status !== "failed" || session.candidateRevisionId) {
    return false;
  }
  const generation = session.traceRepairDebug?.generation;
  return typeof generation?.errorMessage === "string" && generation.errorMessage.length > 0;
}

/** @internal exported for unit tests */
export function resolveTraceRepairFailureStopReason(
  failedCaseCount: number,
  caseResults: TraceRepairCaseResult[],
): "completed_server_likely" | "stopped_generation_error" | "stopped_no_progress" {
  const anyPromoted = caseResults.some((r) => r.promoted);
  if (anyPromoted) {
    return "stopped_no_progress";
  }
  const allServerLikely =
    failedCaseCount > 0 && caseResults.length > 0 && caseResults.every((r) => r.serverLikely);
  if (allServerLikely) {
    return "completed_server_likely";
  }
  const allGenerationFailed =
    failedCaseCount > 0 &&
    caseResults.length > 0 &&
    caseResults.every((r) => r.generationFailedOnly);
  if (allGenerationFailed) {
    return "stopped_generation_error";
  }
  return "stopped_no_progress";
}

export type TraceRepairRunnerParams = {
  convexClient: ConvexHttpClient;
  convexAuthToken: string;
  jobId: string;
  modelApiKeys?: Record<string, string>;
};

export async function captureTraceRepairJobToolSnapshot(args: {
  convexClient: ConvexHttpClient;
  jobId: string;
  leaseOwner: string;
  replayManager: ReturnType<typeof buildReplayManager>;
  replayServerIds: string[];
}): Promise<void> {
  try {
    const { toolSnapshot, toolSnapshotDebug } =
      await captureToolSnapshotForEvalAuthoring(
        args.replayManager,
        args.replayServerIds,
        {
          logPrefix: "trace-repair",
        },
      );

    await args.convexClient.mutation("traceRepair:recordTraceRepairToolSnapshot" as any, {
      jobId: args.jobId,
      leaseOwner: args.leaseOwner,
      toolSnapshot: sanitizeForConvexTransport(toolSnapshot),
      toolSnapshotDebug: sanitizeForConvexTransport(toolSnapshotDebug),
    });
  } catch (error) {
    logger.warn("[trace-repair] Failed to capture tool snapshot", {
      jobId: args.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Linear trace repair: load failed cases → per case, generate a candidate → run the first K
 * verification replays → promote on pass → suite replay when anything was promoted.
 * Exits early with a dedicated stop reason when there are no failed cases to repair.
 */
export async function runTraceRepairJob(params: TraceRepairRunnerParams): Promise<void> {
  const { convexClient, convexAuthToken, jobId } = params;
  const modelApiKeys = params.modelApiKeys;
  const leaseOwner = crypto.randomUUID();

  await convexClient.mutation("traceRepair:claimTraceRepairJobLease" as any, {
    jobId,
    leaseOwner,
    leaseDurationMs: LEASE_MS,
  });

  const hb = setInterval(() => {
    void convexClient
      .mutation("traceRepair:heartbeatTraceRepairJob" as any, {
        jobId,
        leaseOwner,
        leaseDurationMs: LEASE_MS,
      })
      .catch(() => {});
  }, HEARTBEAT_MS);

  try {
    let job: any = await convexClient.query("traceRepair:getTraceRepairJob" as any, {
      jobId,
    });

    const checkCancelled = async () => {
      job = await convexClient.query("traceRepair:getTraceRepairJob" as any, {
        jobId,
      });
      if (job.status === "stopping") {
        await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
          jobId,
          leaseOwner,
          stopReason: "cancelled_by_user",
        });
        return true;
      }
      const suiteNow = await convexClient.query("testSuites:getTestSuite" as any, {
        suiteId: job.testSuiteId,
      });
      if (suiteNow.configRevision !== job.expectedConfigRevision) {
        await convexClient.mutation(
          "traceRepair:cancelTraceRepairJobForSuiteChange" as any,
          { jobId, leaseOwner },
        );
        return true;
      }
      return false;
    };

    const suite = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId: job.testSuiteId,
    });
    if (suite.configRevision !== job.expectedConfigRevision) {
      await convexClient.mutation(
        "traceRepair:cancelTraceRepairJobForSuiteChange" as any,
        { jobId, leaseOwner },
      );
      return;
    }

    if (await checkCancelled()) {
      return;
    }

    const refinement = await convexClient.query(
      "testSuites:getRunRefinementState" as any,
      { suiteRunId: job.sourceRunId },
    );

    let failedCases: FailedCase[] = (refinement?.failedCases ?? []).map((fc: any) => ({
      sourceIterationId: fc.sourceIterationId,
      testCaseId: fc.testCaseId,
      caseKey: fc.caseKey,
    }));

    if (job.scope === "case") {
      failedCases = failedCases.filter((fc) => fc.testCaseId === job.targetTestCaseId);
    }

    if (failedCases.length === 0) {
      await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
        jobId,
        leaseOwner,
        stopReason: "stopped_nothing_to_repair",
      });
      return;
    }

    await convexClient.mutation("traceRepair:advanceTraceRepairJob" as any, {
      jobId,
      leaseOwner,
      phase: "repairing",
      activeCaseKeys: failedCases.map((c) => c.caseKey),
    });

    const testCases =
      (await convexClient.query("testSuites:listTestCases" as any, {
        suiteId: job.testSuiteId,
      })) ?? [];
    const suiteModels = collectSuiteModels(testCases);

    const details = await convexClient.query("testSuites:getTestSuiteRunDetails" as any, {
      runId: job.sourceRunId,
    });
    const iterationByCaseKey = new Map<string, (typeof details.iterations)[0]>();
    for (const it of details?.iterations ?? []) {
      if (it.result !== "failed" || !it.testCaseId) {
        continue;
      }
      const key =
        it.testCaseSnapshot?.caseKey ?? it.testCaseId ?? String(it._id);
      if (!iterationByCaseKey.has(key)) {
        iterationByCaseKey.set(key, it);
      }
    }

    const replayMetadata = await convexClient.query(
      "testSuites:getRunReplayMetadata" as any,
      { runId: job.sourceRunId },
    );
    if (!replayMetadata?.hasServerReplayConfig) {
      throw new Error("This run does not have stored replay config");
    }
    const replayConfig = await fetchReplayConfig(job.sourceRunId, convexAuthToken);
    if (!replayConfig || replayConfig.servers.length === 0) {
      throw new Error("No replay configuration found for this run");
    }
    const replayServerIds = replayConfig.servers.map((s) => s.serverId);
    const replayCaptureManager = buildReplayManager(replayConfig);
    try {
      await connectReplayManagerServers(replayCaptureManager, replayConfig);
      await captureTraceRepairJobToolSnapshot({
        convexClient,
        jobId,
        leaseOwner,
        replayManager: replayCaptureManager,
        replayServerIds,
      });
    } finally {
      await safeDisconnectReplayManager(replayCaptureManager, "tool snapshot");
    }

    const caseConcurrency = parseRefinementCaseConcurrency(
      process.env.TRACE_REPAIR_CASE_CONCURRENCY ?? process.env.REFINEMENT_CASE_CONCURRENCY,
    );

    const caseResults = await runWithConcurrencyLimit(
      failedCases,
      caseConcurrency,
      async (fc) => {
        if (await checkCancelled()) {
          return {
            caseKey: fc.caseKey,
            promoted: false,
            serverLikely: false,
            lastSessionId: null as string | null,
          };
        }

        await convexClient.mutation("traceRepair:advanceTraceRepairJob" as any, {
          jobId,
          leaseOwner,
          phase: "repairing",
          currentCaseKey: fc.caseKey,
        });

        let sourceIterationId = fc.sourceIterationId;
        const attemptSigs: string[] = [];
        let lastSessionId: string | null = null;
        let promoted = false;
        let serverLikely = false;
        let generationFailedOnly = true;

        for (let attempt = 1; attempt <= job.attemptLimit; attempt++) {
          if (await checkCancelled()) {
            break;
          }

          const req = await convexClient.mutation(
            "testSuites:requestTraceRepairCandidate" as any,
            {
              testCaseId: fc.testCaseId,
              sourceRunId: job.sourceRunId,
              sourceIterationId,
              traceRepairJobId: jobId,
              attemptNumber: attempt,
            },
          );
          const sessionId = req.sessionId as string;
          lastSessionId = sessionId;

          let pollMs = POLL_MS_INITIAL;
          const genStart = Date.now();
          let sessionReady = false;
          let failedSession: TraceRepairSessionSnapshot = null;
          while (Date.now() - genStart < CANDIDATE_TIMEOUT_MS) {
            const s = await convexClient.query("testSuites:getRefinementSession" as any, {
              sessionId,
            });
            if (s?.status === "ready") {
              sessionReady = true;
              break;
            }
            if (s?.status === "failed") {
              failedSession = s as TraceRepairSessionSnapshot;
              break;
            }
            await sleep(pollMs);
            pollMs = Math.min(POLL_MS_MAX, Math.floor(pollMs * 1.5));
          }

          if (!sessionReady) {
            if (!isTraceRepairGenerationFailureSession(failedSession)) {
              generationFailedOnly = false;
            }
            attemptSigs.push("");
            continue;
          }

          generationFailedOnly = false;

          await convexClient.mutation("testSuites:beginRefinementVerification" as any, {
            sessionId,
          });

          const pack = await convexClient.query(
            "testSuites:getRefinementSessionForVerification" as any,
            { sessionId },
          );
          const sess = pack?.session;
          const candSnap = pack?.candidateSnapshot;

          const repIt = iterationByCaseKey.get(fc.caseKey);
          const fullPlan = buildRefinementVerificationPlan({
            session: sess
              ? {
                  candidateParaphraseQuery: sess.candidateParaphraseQuery,
                  candidateSnapshot: candSnap
                    ? {
                        query: candSnap.query,
                        models: candSnap.models ?? [],
                      }
                    : null,
                }
              : null,
            representativeIteration: repIt
              ? { testCaseSnapshot: repIt.testCaseSnapshot ?? undefined }
              : null,
            suiteModels,
          });
          if (fullPlan.length === 0) {
            attemptSigs.push("");
            continue;
          }
          const k = Math.min(
            fullPlan.length,
            Math.max(1, Math.min(2, Number(job.quickPassesRequired) || 1)),
          );
          const plan = fullPlan.slice(0, k);

          await convexClient.mutation(
            "testSuites:recordTraceRepairVerificationPlan" as any,
            {
              sessionId,
              quickPassesRequired: plan.length,
              verificationPlan: plan,
            },
          );

          let quickOutcome: string | undefined;
          for (const step of plan) {
            const manager = buildReplayManager(replayConfig);
            try {
              await connectReplayManagerServers(manager, replayConfig);
              if (!fc.testCaseId) {
                throw new Error("Missing testCaseId for verification");
              }
              const stepKeys = resolveModelApiKeys(
                step.provider,
                step.model,
                modelApiKeys,
              );
              const mergedApiKeys =
                stepKeys && modelApiKeys
                  ? { ...modelApiKeys, ...stepKeys }
                  : (stepKeys ?? modelApiKeys);
              const res = await runEvalTestCaseWithManager(
                manager,
                {
                  testCaseId: fc.testCaseId,
                  model: step.model,
                  provider: step.provider,
                  serverIds: replayServerIds,
                  modelApiKeys: mergedApiKeys,
                  convexAuthToken,
                  testCaseOverrides: {
                    query: step.query,
                    expectedToolCalls:
                      (candSnap?.expectedToolCalls as unknown[] | undefined) ?? [],
                    isNegativeTest: Boolean(candSnap?.isNegativeTest),
                    runs: 1,
                  },
                },
                { skipLastMessageRunUpdate: true },
              );
              const iterationId = (res.iteration as { _id?: string } | null)?._id;
              if (!iterationId) {
                throw new Error("Verification run did not return an iteration");
              }
              await convexClient.mutation(
                "testSuites:recordRefinementVerificationRun" as any,
                {
                  sessionId,
                  label: step.label,
                  iterationId,
                },
              );
            } finally {
              await safeDisconnectReplayManager(
                manager,
                `verification step ${step.label}`,
              );
            }

            const sCheck = await convexClient.query(
              "testSuites:getRefinementSession" as any,
              { sessionId },
            );
            if (sCheck?.status === "completed") {
              quickOutcome = sCheck.outcome as string | undefined;
              break;
            }
          }

          if (quickOutcome === "improved_test") {
            await convexClient.mutation("testSuites:promoteRefinementCandidate" as any, {
              sessionId,
            });
            await convexClient.mutation(
              "traceRepair:syncTraceRepairJobConfigAfterPromote" as any,
              { jobId, leaseOwner },
            );
            promoted = true;
            break;
          }

          const sFinal = await convexClient.query("testSuites:getRefinementSession" as any, {
            sessionId,
          });
          const planLabels = plan.map((s: RefinementVerificationPlanStep) => s.label);
          const sig = signatureFromFailedTraceRepairAttempt(
            sFinal?.verificationRuns ?? [],
            planLabels,
          );
          attemptSigs.push(sig);
          const nextIt = failedQuickIterationId(sFinal?.verificationRuns ?? [], planLabels);
          if (nextIt) {
            sourceIterationId = nextIt;
          }
        }

        if (
          !promoted &&
          job.attemptLimit > 1 &&
          attemptSigs.length === job.attemptLimit &&
          lastSessionId != null
        ) {
          await convexClient.mutation("testSuites:finalizeTraceRepairAttemptFailure" as any, {
            sessionId: lastSessionId,
            attemptSignatures: attemptSigs,
            traceRepairJobId: jobId,
            leaseOwner,
          });
          const sDone = await convexClient.query("testSuites:getRefinementSession" as any, {
            sessionId: lastSessionId,
          });
          if (sDone?.outcome === "server_likely") {
            serverLikely = true;
          }
        }

        return {
          caseKey: fc.caseKey,
          promoted,
          serverLikely,
          generationFailedOnly: !promoted && !serverLikely && generationFailedOnly,
          lastSessionId,
        };
      },
    );

    if (await checkCancelled()) {
      return;
    }

    const anyPromoted = caseResults.some((r) => r.promoted);
    const failedStopReason = resolveTraceRepairFailureStopReason(
      failedCases.length,
      caseResults,
    );
    const allServerLikely = failedStopReason === "completed_server_likely";

    if (job.scope === "case") {
      if (anyPromoted) {
        await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
          jobId,
          leaseOwner,
          stopReason: "completed_case",
        });
      } else if (allServerLikely) {
        await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
          jobId,
          leaseOwner,
          stopReason: "completed_server_likely",
        });
      } else {
        await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
          jobId,
          leaseOwner,
          stopReason: failedStopReason,
        });
      }
      return;
    }

    if (!anyPromoted) {
      await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
        jobId,
        leaseOwner,
        stopReason: failedStopReason,
      });
      return;
    }

    await convexClient.mutation("traceRepair:advanceTraceRepairJob" as any, {
      jobId,
      leaseOwner,
      phase: "replaying",
    });
    const suiteAtReplayStart = await convexClient.query("testSuites:getTestSuite" as any, {
      suiteId: job.testSuiteId,
    });

    const replay = await executeSuiteReplayFromRun({
      convexClient,
      convexAuthToken,
      sourceRunId: job.sourceRunId,
      modelApiKeys,
      useCurrentSuiteConfig: true,
    });

    await convexClient.mutation("traceRepair:bindTraceRepairReplayRun" as any, {
      jobId,
      leaseOwner,
      replayRunId: replay.runId,
    });

    const replayRun = await convexClient.query("testSuites:getTestSuiteRun" as any, {
      runId: replay.runId,
    });
    const sourceRun = await convexClient.query("testSuites:getTestSuiteRun" as any, {
      runId: job.sourceRunId,
    });
    const replayDetails = await convexClient.query(
      "testSuites:getTestSuiteRunDetails" as any,
      { runId: replay.runId },
    );
    const replayFailedCaseKeys = Array.from(
      new Set(
        (replayDetails?.iterations ?? [])
          .filter((it: any) => it.result === "failed")
          .map(
            (it: any) =>
              it.testCaseSnapshot?.caseKey ??
              (it.testCaseId ? `ui:${it.testCaseId}` : undefined),
          )
          .filter((caseKey: string | undefined): caseKey is string => Boolean(caseKey)),
      ),
    );
    const promotedCaseKeys = caseResults
      .filter((result) => result.promoted)
      .map((result) => result.caseKey);

    await convexClient.mutation("traceRepair:recordTraceRepairReplayDebug" as any, {
      jobId,
      leaseOwner,
      replayDebug: {
        replayMode: "current_suite_with_source_environment",
        replayRequestedAt: Date.now(),
        sourceRunId: job.sourceRunId,
        sourceRunConfigRevision: sourceRun?.configRevision,
        suiteConfigRevisionAtReplayStart: suiteAtReplayStart?.configRevision,
        replayRunId: replay.runId,
        replayRunConfigRevision: replayRun?.configRevision,
        promotedCaseKeys,
        replayFailedCaseKeys,
        replayOutcomes: promotedCaseKeys.map((caseKey) => ({
          caseKey,
          outcome: replayFailedCaseKeys.includes(caseKey)
            ? "regressed"
            : "durable_fix",
        })),
      },
    });

    await convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
      jobId,
      leaseOwner,
      stopReason: "completed_replayed",
    });
  } catch (err) {
    logger.error("[trace-repair] worker failed", err, { jobId });
    try {
      await params.convexClient.mutation("traceRepair:finalizeTraceRepairJob" as any, {
        jobId,
        leaseOwner,
        stopReason: "worker_error",
        lastError: err instanceof Error ? err.message : String(err),
      });
    } catch {
      /* best effort */
    }
  } finally {
    clearInterval(hb);
  }
}
