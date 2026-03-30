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

    await runEvalSuiteWithAiSdk({
      suiteId: replayMetadata.suiteId,
      runId,
      config,
      modelApiKeys: modelApiKeys ?? undefined,
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
