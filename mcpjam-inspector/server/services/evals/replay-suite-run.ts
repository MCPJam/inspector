import { checkEvalExecutionAdmission, checkEvalHarnessAdmission, casesAssertingWidgetRender, failRunBeforeExecution } from "./harness-admission.js";
import { harnessToolPolicyLaunchRefusal } from "../../utils/harness/harness-proxy-policy-enforcement.js";
import { harnessOfHostConfig } from "./harness-admission.js";
import { localHarnessIdOf, shouldUseLocalHarness } from "../../utils/harness/local/run-resources.js";
import type { ConvexHttpClient } from "convex/browser";
import { runEvalSuiteWithAiSdk } from "../evals-runner.js";
import {
  startSuiteRunWithRecorder,
  type SuiteRunRecorder,
} from "./recorder.js";
import {
  buildReplayManager,
  captureToolSnapshotForEvalAuthoring,
  connectReplayManagerServers,
  fetchReplayConfig,
  requireConvexHttpUrl,
  storeReplayConfig,
} from "./route-helpers.js";
import { logger } from "../../utils/logger.js";
import {
  resolveOrgModelConfig,
  type ResolvedOrgModelConfig,
} from "../../utils/org-model-config.js";
import { loadSuiteHostConfig } from "./compat-runtime.js";
import { resolveOpenAiCompatForHostConfig } from "@mcpjam/sdk/host-config/internal";
import { recoverToolPolicyFromSourceRun } from "./replay-tool-policy.js";
import { resolveFrozenRunGradingMode } from "./grading-mode.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

export type ExecuteSuiteReplayFromRunParams = {
  convexClient: ConvexHttpClient;
  convexAuthToken: string;
  sourceRunId: string;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  notes?: string;
  passCriteria?: { minimumPassRate: number };
  useCurrentSuiteConfig?: boolean;
  /**
   * E3 — replay only part of the source run. `"failed_cases"` reruns the
   * cases with a trial that did not complete and pass; the BACKEND picks them
   * and stamps the new run `rerunOfRunId` + `rerunScope`. Absent replays the
   * whole run, exactly as before.
   */
  scope?: SuiteReplayScope;
};

/** The subset a replay can be narrowed to. */
export type SuiteReplayScope = "failed_cases";

/**
 * The backend's subset-rerun refusals, as readable route errors. Each one is
 * raised before any run row exists, and each names something the caller can
 * act on, so none of them should surface as an opaque 500. Null for anything
 * else, so a real fault stays a fault.
 */
const RERUN_REFUSALS: Record<
  string,
  { status: number; code: ErrorCode; fallback: string }
> = {
  RERUN_NOTHING_TO_RERUN: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback: "Every case in that run passed, so there is nothing to rerun.",
  },
  RERUN_SOURCE_NOT_TERMINAL: {
    status: 409,
    code: ErrorCode.CONFLICT,
    fallback: "The run to rerun is still in progress.",
  },
  RERUN_SOURCE_SUITE_MISMATCH: {
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    fallback: "The run to rerun belongs to a different suite.",
  },
};

export function rerunRefusalError(error: unknown): WebRouteError | null {
  const data = (error as { data?: unknown } | null)?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as { code?: unknown; message?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  const refusal = code ? RERUN_REFUSALS[code] : undefined;
  if (!code || !refusal) return null;
  const message =
    typeof record.message === "string" && record.message.trim()
      ? record.message
      : refusal.fallback;
  return new WebRouteError(refusal.status, refusal.code, message, {
    reason: code,
  });
}

export type ExecuteSuiteReplayFromRunResult = {
  success: true;
  suiteId: string;
  runId: string;
  sourceRunId: string;
  message: string;
};

export type PreparedSuiteReplayFromRunResult = {
  suiteId: string;
  runId: string;
  sourceRunId: string;
  recorder: SuiteRunRecorder;
  execute: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/**
 * Prepare a replay run through run creation. The returned cleanup keeps replay
 * MCP connections alive while detached execution continues after HTTP response.
 */
export async function prepareSuiteReplayFromRun(
  params: ExecuteSuiteReplayFromRunParams,
): Promise<PreparedSuiteReplayFromRunResult> {
  const {
    convexClient,
    convexAuthToken,
    sourceRunId,
    modelApiKeys,
    orgModelConfig,
    notes,
    passCriteria,
    useCurrentSuiteConfig,
    scope,
  } = params;

  const convexHttpUrl = requireConvexHttpUrl();
  const replayMetadata = await convexClient.query(
    "testSuites:getRunReplayMetadata" as any,
    { runId: sourceRunId },
  );

  if (!replayMetadata?.hasServerReplayConfig) {
    throw new Error("This run does not have stored replay config");
  }

  const replayConfig = await fetchReplayConfig(sourceRunId, convexAuthToken);
  if (!replayConfig || replayConfig.servers.length === 0) {
    throw new Error("No replay configuration found for this run");
  }

  // Recovered BEFORE the replay run row is created: an unrecoverable policy
  // must abort the replay outright, not strand a created run.
  const replayToolPolicy = await recoverToolPolicyFromSourceRun({
    convexClient,
    sourceRunId,
  });
  if (replayToolPolicy) {
    logger.info("[evals] Replay inherits the source run's tool policy", {
      sourceRunId,
      mode: replayToolPolicy.mode,
    });
  }

  const replayManager = buildReplayManager(replayConfig);
  try {
    await connectReplayManagerServers(replayManager, replayConfig);
    const replayServerIds = replayConfig.servers.map((server) => server.serverId);
    const { toolSnapshot, toolSnapshotDebug } =
      await captureToolSnapshotForEvalAuthoring(replayManager, replayServerIds, {
        logPrefix: "evals.replay",
      });

    const launchHostConfig = useCurrentSuiteConfig === true
      ? await loadSuiteHostConfig(convexClient, replayMetadata.suiteId)
      : { harness: typeof replayMetadata.executionEngine === "string" && replayMetadata.executionEngine.startsWith("harness:")
          ? replayMetadata.executionEngine.slice("harness:".length) : undefined };
    const replayHarness = harnessOfHostConfig(launchHostConfig);
    const runtimeVenue = await shouldUseLocalHarness(
      replayHarness, convexAuthToken, replayMetadata.projectId, { scope: "unattended" },
    ) ? "local" : "hosted";
    const replayLocalHarness = runtimeVenue === "local" ? localHarnessIdOf(replayHarness) : null;

    const {
      runId,
      harnessRuntimeVenue,
      recorder,
      config,
      hostConfig: runHostConfigSnapshot,
      gradingEngine: runGradingEngine,
      environmentRef,
    } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: replayMetadata.suiteId,
      notes,
      passCriteria,
      serverIds: replayServerIds,
      replayedFromRunId: sourceRunId,
      // Only when a scope was asked for: an unscoped replay sends exactly the
      // args it always sent, so an older backend keeps accepting it.
      ...(scope ? { rerunOfRunId: sourceRunId, rerunScope: scope } : {}),
      runtimeVenue,
      ...(replayLocalHarness ? { localHarnessIds: [replayLocalHarness] } : {}),
      useCurrentSuiteConfig,
      environmentOverride:
        useCurrentSuiteConfig === true
          ? (replayMetadata.environment ?? { servers: replayServerIds })
          : undefined,
      toolSnapshot,
      toolSnapshotDebug,
    });
    const replayHostConfig =
      runHostConfigSnapshot ??
      (await loadSuiteHostConfig(convexClient, replayMetadata.suiteId));
    const localExecution = harnessRuntimeVenue === "local";
    const executionAdmission = checkEvalExecutionAdmission({
      localExecution,
      hostConfig: replayHostConfig,
      pinnedComputerImageId: (config.environment as { computerEnvironmentId?: string } | undefined)?.computerEnvironmentId ?? null,
    });
    const harnessAdmission = checkEvalHarnessAdmission({
      localExecution,
      hostConfig: replayHostConfig, serverIds: replayServerIds, cases: config.tests,
      widgetAssertingCaseTitles: casesAssertingWidgetRender(config.tests),
      projectId: replayMetadata.projectId ?? null,
    });
    const refusal = !executionAdmission.ok ? executionAdmission.reason : !harnessAdmission.ok ? harnessAdmission.reason :
      harnessToolPolicyLaunchRefusal({ hasToolPolicy: Boolean(replayToolPolicy), harness: harnessAdmission.harness,
        localExecution });
    if (refusal) {
      await failRunBeforeExecution(convexClient, recorder, runId, { reason: refusal });
      throw new Error(refusal);
    }
    const suiteInjectOpenAiCompat =
      resolveOpenAiCompatForHostConfig(replayHostConfig);

    if (replayConfig.servers.length > 0) {
      try {
        await storeReplayConfig(runId, replayConfig.servers, convexAuthToken);
      } catch (error) {
        logger.warn("[evals] Failed to store replay config for replay run", {
          runId,
          sourceRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Resolve org model config: prefer client-sent keys, fall back to org config.
    const hasClientKeys =
      !!modelApiKeys && Object.keys(modelApiKeys).length > 0;
    const resolvedModelApiKeys = hasClientKeys ? modelApiKeys : undefined;
    let resolvedOrgModelConfig = orgModelConfig;
    const replayProjectId =
      typeof replayMetadata.projectId === "string"
        ? replayMetadata.projectId
        : undefined;
    const replayOrgConfigTarget = replayProjectId
      ? { projectId: replayProjectId }
      : undefined;
    if (
      !resolvedModelApiKeys &&
      !resolvedOrgModelConfig &&
      replayOrgConfigTarget
    ) {
      try {
        resolvedOrgModelConfig = await resolveOrgModelConfig(
          replayOrgConfigTarget,
          {
            bearerToken: convexAuthToken,
            serverIds: replayServerIds,
          },
        );
      } catch (error) {
        logger.warn("[evals] Failed to resolve org model config for replay", {
          sourceRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      suiteId: replayMetadata.suiteId,
      runId,
      sourceRunId,
      recorder,
      execute: async () => {
        await runEvalSuiteWithAiSdk({
          suiteId: replayMetadata.suiteId,
          runId,
          config,
          modelApiKeys: resolvedModelApiKeys ?? undefined,
          orgModelConfig: resolvedOrgModelConfig,
          orgModelConfigTarget: replayOrgConfigTarget,
          convexClient,
          convexHttpUrl,
          convexAuthToken,
          mcpClientManager: replayManager,
          recorder,
          suiteInjectOpenAiCompat,
          suiteHostConfig: replayHostConfig,
          harnessRuntimeVenue,
          // B3b: a replay is a RUN, and it grades under its own frozen
          // position like any other. Omitting this let the runner fall back to
          // the env-only resolver in `buildIterationFinishParams`, so a replay
          // of an `off` or `shadow` run would grade at whatever the process env
          // allowed — a replay reaching a different authority than the record
          // it replays. An absent stamp is the backend's `off`, not an absent
          // opinion; see the same translation in `routes/shared/evals.ts`.
          gradingMode: resolveFrozenRunGradingMode(runGradingEngine),
          // Current backends return the frozen environment. Older deployments
          // still refuse an uncheckable grant instead of guessing an environment.
          ...(environmentRef?.environmentId
            ? { projectEnvironmentId: environmentRef.environmentId }
            : { projectEnvironmentUnresolvedReason:
                "Replaying this run does not carry its Project Environment through to the runner. Update the backend and retry." }),
          ...(replayToolPolicy ? { toolPolicy: replayToolPolicy } : {}),
        });
      },
      cleanup: () => replayManager.disconnectAllServers(),
    };
  } catch (error) {
    await replayManager.disconnectAllServers();
    throw error;
  }
}

/**
 * Full suite replay used by synchronous `/replay-run` callers and trace repair.
 */
export async function executeSuiteReplayFromRun(
  params: ExecuteSuiteReplayFromRunParams,
): Promise<ExecuteSuiteReplayFromRunResult> {
  const prepared = await prepareSuiteReplayFromRun(params);
  try {
    await prepared.execute();
    return {
      success: true,
      suiteId: prepared.suiteId,
      runId: prepared.runId,
      sourceRunId: prepared.sourceRunId,
      message: "Replay completed successfully.",
    };
  } finally {
    await prepared.cleanup();
  }
}
