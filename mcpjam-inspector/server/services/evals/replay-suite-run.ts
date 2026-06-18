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

export type ExecuteSuiteReplayFromRunParams = {
  convexClient: ConvexHttpClient;
  convexAuthToken: string;
  sourceRunId: string;
  modelApiKeys?: Record<string, string>;
  orgModelConfig?: ResolvedOrgModelConfig;
  notes?: string;
  passCriteria?: { minimumPassRate: number };
  useCurrentSuiteConfig?: boolean;
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

  if (!replayMetadata?.hasServerReplayConfig) {
    throw new Error("This run does not have stored replay config");
  }

  const replayConfig = await fetchReplayConfig(sourceRunId, convexAuthToken);
  if (!replayConfig || replayConfig.servers.length === 0) {
    throw new Error("No replay configuration found for this run");
  }

  const replayManager = buildReplayManager(replayConfig);
  try {
    await connectReplayManagerServers(replayManager, replayConfig);
    const replayServerIds = replayConfig.servers.map((server) => server.serverId);
    const { toolSnapshot, toolSnapshotDebug } =
      await captureToolSnapshotForEvalAuthoring(replayManager, replayServerIds, {
        logPrefix: "evals.replay",
      });

    const {
      runId,
      recorder,
      config,
      hostConfig: runHostConfigSnapshot,
    } = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: replayMetadata.suiteId,
      notes,
      passCriteria,
      serverIds: replayServerIds,
      replayedFromRunId: sourceRunId,
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
