import { checkEvalExecutionAdmission, checkEvalHarnessAdmission, casesAssertingWidgetRender, failRunBeforeExecution } from "./harness-admission.js";
import { harnessToolPolicyLaunchRefusal } from "../../utils/harness/harness-proxy-policy-enforcement.js";
import { harnessOfHostConfig } from "./harness-admission.js";
import { explainEvalHarnessRefusal } from "./explain-harness-refusal.js";
import { localHarnessIdOf, shouldUseLocalHarness } from "../../utils/harness/local/run-resources.js";
import type { ConvexHttpClient } from "convex/browser";
import type { MCPClientManager } from "@mcpjam/sdk";
import { managerAccountsAtRun } from "../../utils/mcp-connections.js";
import { freezeEvalRunWebAccounts } from "../web-clients/web-client-run.js";
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
  type ReplayConfig,
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
import { prepareClientKeyRun } from "./org-policy-client-keys.js";
import {
  fetchRunPinnedSkillsWithRetry,
  shouldSkipExecution,
} from "../../routes/shared/evals.js";
import {
  buildPinnedSkillSource,
  type BuiltPinnedSkillSource,
} from "./pinned-skill-source.js";
import type { RunPinnedPluginVersion } from "./run-plugin-snapshot.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { loadEvalRunAccountPlan, type EvalAccountPlan } from "./suite-account-choices.js";

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
   * A local replay's servers, authorized again for this run
   * (`projectReplayServers`), and the id each name the source run used now
   * runs under. Absent, or answering `undefined`, the replay dials the stored
   * configs.
   */
  openReplayServers?: (target: {
    projectId?: string;
    suiteId: string;
    replayConfig: ReplayConfig;
    environment?: { servers?: unknown; serverBindings?: Array<{ serverName: string; projectServerId?: string }> };
    plan?: EvalAccountPlan;
  }) => Promise<
    | {
        manager: MCPClientManager;
        serverIds: string[];
        serverBindings: Array<{ serverName: string; projectServerId: string }>;
        managerForCase?: (caseId: string | undefined) => MCPClientManager;
        close?: () => Promise<void>;
      }
    | undefined
  >;
};

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
  deduped?: boolean;
  status?: string;
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
  } = params;

  const convexHttpUrl = requireConvexHttpUrl();
  const replayMetadata = await convexClient.query(
    "testSuites:getRunReplayMetadata" as any,
    { runId: sourceRunId },
  );

  if (!replayMetadata?.hasServerReplayConfig && !replayMetadata?.hasPerCaseAccounts) {
    throw new Error("This run does not have stored replay config");
  }

  const replayConfig = replayMetadata.hasPerCaseAccounts
    ? { runId: sourceRunId, suiteId: replayMetadata.suiteId, servers: [] }
    : await fetchReplayConfig(sourceRunId, convexAuthToken);
  if (!replayConfig || (!replayConfig.servers.length && !replayMetadata.hasPerCaseAccounts)) {
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

  const replayProjectId =
    typeof replayMetadata.projectId === "string"
      ? replayMetadata.projectId
      : undefined;
  const replayOrgConfigTarget = replayProjectId
    ? { projectId: replayProjectId }
    : undefined;
  const serverIds = (replayMetadata.environment?.serverBindings ?? [])
    .flatMap(({ projectServerId }: { projectServerId?: string }) => projectServerId ? [projectServerId] : []);
  const plan = replayMetadata.hasPerCaseAccounts ? await loadEvalRunAccountPlan(convexClient, {
    suiteId: replayMetadata.suiteId, sourceRunId, serverIds,
  }) : undefined;
  const opened = await params.openReplayServers?.({
    projectId: replayProjectId,
    suiteId: replayMetadata.suiteId,
    replayConfig,
    environment: replayMetadata.environment,
    ...(plan ? { plan } : {}),
  });
  if (replayMetadata.hasPerCaseAccounts && !opened?.managerForCase) {
    await opened?.manager.disconnectAllServers();
    throw new WebRouteError(409, ErrorCode.CONFLICT, "The recorded MCP accounts could not be opened. Reconnect them and retry the replay.");
  }
  const replayServerIds =
    opened?.serverIds ?? replayConfig.servers.map((server) => server.serverId);
  const replayManager = opened?.manager ?? buildReplayManager(replayConfig);
  const cleanup = opened?.close ?? (() => replayManager.disconnectAllServers());
  try {
    // Resolve org model config: prefer client-sent keys, fall back to org config.
    const clientKeyRun = await prepareClientKeyRun(
      { modelApiKeys, orgModelConfig, convexAuthToken },
      replayProjectId,
      replayServerIds,
    );
    const resolvedModelApiKeys = clientKeyRun.modelApiKeys;
    let resolvedOrgModelConfig = clientKeyRun.orgModelConfig;
    if (!opened) await connectReplayManagerServers(replayManager, replayConfig);
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
      pluginVersions: runPluginVersions = [],
      deduped,
      status,
    } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: replayMetadata.suiteId,
      notes,
      passCriteria,
      serverIds: replayServerIds,
      replayedFromRunId: sourceRunId,
      runtimeVenue,
      ...(replayLocalHarness ? { localHarnessIds: [replayLocalHarness] } : {}),
      useCurrentSuiteConfig,
      environmentOverride:
        useCurrentSuiteConfig === true
          ? (replayMetadata.environment ?? { servers: replayServerIds })
          : undefined,
      toolSnapshot,
      toolSnapshotDebug,
      // Only a manager authorized for this run knows the accounts it runs as.
      ...(opened ? { accountsAtRun: managerAccountsAtRun(replayManager) } : {}),
      ...(plan ? { evalAccountPlan: plan } : {}),
    });
    if (deduped === true) {
      return {
        suiteId: replayMetadata.suiteId, runId, sourceRunId, recorder, deduped, status,
        execute: async () => { throw new Error(`Eval run ${runId} already has an executor. Read its existing result.`); },
        cleanup,
      };
    }
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
    const refusal = !executionAdmission.ok ? executionAdmission.reason
      : !harnessAdmission.ok ? await explainEvalHarnessRefusal({
        admission: harnessAdmission, bearer: convexAuthToken, projectId: replayMetadata.projectId ?? null })
      : harnessToolPolicyLaunchRefusal({ hasToolPolicy: Boolean(replayToolPolicy), harness: harnessAdmission.harness,
        localExecution });
    if (refusal) {
      await failRunBeforeExecution(convexClient, recorder, runId, { reason: refusal });
      throw new Error(refusal);
    }
    // A replay is a run like any other: a web client's freezes its web
    // accounts before any turn.
    await freezeEvalRunWebAccounts({
      convexClient,
      runId,
      harness: harnessAdmission.harness,
      failRun: (reason) => failRunBeforeExecution(convexClient, recorder, runId, { reason }),
    });
    // Like an eval run, a replay whose frozen skill can't be fetched stops
    // here, before its first model call, rather than run without it.
    let frozenSkills: BuiltPinnedSkillSource;
    try {
      frozenSkills = await replayRunSkills({
        convexClient,
        runId,
        pluginVersions: runPluginVersions,
        serverIds: replayServerIds,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failRunBeforeExecution(convexClient, recorder, runId, {
        reason: reason.slice(0, 500),
      });
      throw error;
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

    // No client-sent keys: fall back to the organization's config.
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

    // The source run's environment may name servers that now run under
    // their ids; the later bindings win.
    const runConfig = opened?.serverBindings.length
      ? {
          ...config,
          environment: {
            ...config.environment,
            serverBindings: [
              ...(config.environment.serverBindings ?? []),
              ...opened.serverBindings,
            ],
          },
        }
      : config;
    return {
      suiteId: replayMetadata.suiteId,
      runId,
      sourceRunId,
      recorder,
      execute: async () => {
        await runEvalSuiteWithAiSdk({
          suiteId: replayMetadata.suiteId,
          runId,
          config: runConfig,
          modelApiKeys: resolvedModelApiKeys ?? undefined,
          orgModelConfig: resolvedOrgModelConfig,
          orgModelConfigTarget: replayOrgConfigTarget,
          convexClient,
          convexHttpUrl,
          convexAuthToken,
          mcpClientManager: replayManager,
          accountManagerForCase: opened?.managerForCase,
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
          pinnedSkillSource: frozenSkills.pinnedSkillSource,
        });
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * A replay's frozen skills. The backend freezes them when it starts the
 * replay run (its source run's pins and plugin versions, copied, unless the
 * replay asked for the suite's current config), so they are read from the
 * replay run itself and prepared as an eval run prepares its own. A run that
 * pinned none gets an empty set, never the project's skills as they are now.
 */
export async function replayRunSkills(args: {
  convexClient: Parameters<typeof fetchRunPinnedSkillsWithRetry>[0];
  runId: string;
  pluginVersions: readonly RunPinnedPluginVersion[];
  serverIds: readonly string[];
}): Promise<BuiltPinnedSkillSource> {
  const pins = await fetchRunPinnedSkillsWithRetry(
    args.convexClient,
    args.runId,
  );
  return buildPinnedSkillSource({
    pins: pins ?? [],
    pluginVersions: args.pluginVersions,
    // A replay connects the servers its source run stored, not plugin
    // servers; a plugin skill's ref comes from the versions alone.
    pluginServers: [],
    effectiveServerIds: args.serverIds,
  });
}

/**
 * Full suite replay used by synchronous `/replay-run` callers.
 */
export async function executeSuiteReplayFromRun(
  params: ExecuteSuiteReplayFromRunParams,
): Promise<ExecuteSuiteReplayFromRunResult> {
  const prepared = await prepareSuiteReplayFromRun(params);
  try {
    if (!shouldSkipExecution(prepared)) await prepared.execute();
    return {
      success: true,
      suiteId: prepared.suiteId,
      runId: prepared.runId,
      sourceRunId: prepared.sourceRunId,
      message: prepared.deduped === true ? "An existing replay run was found. Read its status for the result." : "Replay completed successfully.",
    };
  } finally {
    await prepared.cleanup();
  }
}
