import type { ConvexHttpClient } from "convex/browser";
import { runEvalSuiteWithAiSdk } from "../evals-runner.js";
import { startSuiteRunWithRecorder } from "./recorder.js";
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
  buildModelApiKeysFromOrgConfig,
} from "../../utils/org-model-config.js";

export type ExecuteSuiteReplayFromRunParams = {
  convexClient: ConvexHttpClient;
  convexAuthToken: string;
  sourceRunId: string;
  modelApiKeys?: Record<string, string>;
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

/**
 * Full suite replay used by `/replay-run` and trace repair.
 */
export async function executeSuiteReplayFromRun(
  params: ExecuteSuiteReplayFromRunParams,
): Promise<ExecuteSuiteReplayFromRunResult> {
  const {
    convexClient,
    convexAuthToken,
    sourceRunId,
    modelApiKeys,
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
  await connectReplayManagerServers(replayManager, replayConfig);
  const replayServerIds = replayConfig.servers.map((server) => server.serverId);
  const { toolSnapshot, toolSnapshotDebug } =
    await captureToolSnapshotForEvalAuthoring(replayManager, replayServerIds, {
      logPrefix: "evals.replay",
    });

  try {
    const { runId, recorder, config } = await startSuiteRunWithRecorder({
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

    // Resolve model API keys: prefer client-sent keys, fall back to org config
    let resolvedModelApiKeys = modelApiKeys;
    if (!resolvedModelApiKeys && replayMetadata.workspaceId) {
      try {
        const orgConfig = await resolveOrgModelConfig({
          workspaceId: replayMetadata.workspaceId,
        });
        resolvedModelApiKeys = buildModelApiKeysFromOrgConfig(orgConfig);
      } catch (error) {
        logger.warn("[evals] Failed to resolve org model config for replay", {
          sourceRunId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await runEvalSuiteWithAiSdk({
      suiteId: replayMetadata.suiteId,
      runId,
      config,
      modelApiKeys: resolvedModelApiKeys ?? undefined,
      convexClient,
      convexHttpUrl,
      convexAuthToken,
      mcpClientManager: replayManager,
      recorder,
    });

    return {
      success: true,
      suiteId: replayMetadata.suiteId,
      runId,
      sourceRunId,
      message: "Replay completed successfully.",
    };
  } finally {
    await replayManager.disconnectAllServers();
  }
}
