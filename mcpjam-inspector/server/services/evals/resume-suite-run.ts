/**
 * E4.3 — rebuild an interrupted run's execution from its own record, and
 * run only what is left of it.
 *
 * Shaped like `prepareSuiteReplayFromRun` and built from the same pieces —
 * the run's stored replay config (`fetchReplayConfig`), the replay manager
 * (`buildReplayManager` / `connectReplayManagerServers`) and its recovered
 * tool policy — with one difference that matters: a replay starts a NEW run,
 * a resume starts nothing. `startSuiteRunWithRecorder({ resumeRunId })` reads
 * the run's frozen launch payload (`evalRunLeases:getRunResumeContext`) and
 * attaches a recorder to the existing run id; `beginExecutionAttempt` then
 * records this as a new attempt that follows the interrupted one.
 *
 * Everything the run froze stays frozen: its cases, budgets, grading position,
 * host config, pinned skills and deadline. Only the requeued rows run.
 */
import type { ConvexHttpClient } from "convex/browser";
import { runEvalSuiteWithAiSdk } from "../evals-runner.js";
import { startSuiteRunWithRecorder } from "./recorder.js";
import {
  buildReplayManager,
  connectReplayManagerServers,
  fetchReplayConfig,
  requireConvexHttpUrl,
} from "./route-helpers.js";
import { logger } from "../../utils/logger.js";
import {
  resolveOrgModelConfig,
  type ResolvedOrgModelConfig,
} from "../../utils/org-model-config.js";
import { loadSuiteHostConfig } from "./compat-runtime.js";
import {
  extractHostExecutionPolicy,
  resolveOpenAiCompatForHostConfig,
} from "@mcpjam/sdk/host-config/internal";
import { recoverToolPolicyFromSourceRun } from "./replay-tool-policy.js";
import { resolveFrozenRunGradingMode } from "./grading-mode.js";
import { fetchRunPinnedSkillsWithRetry } from "../../routes/shared/evals.js";
import { buildPinnedSkillSource } from "./pinned-skill-source.js";
import { resolveSuiteRunPluginServers } from "../plugins/run-plugin-servers.js";
import { withPluginExecutionServers } from "./plugin-execution-servers.js";

export type PrepareSuiteResumeParams = {
  convexClient: ConvexHttpClient;
  /** The run creator's delegated token (re-minted per resume). */
  convexAuthToken: string;
  runId: string;
  /** From the resume claim: this process is now the run's driver. */
  driverToken: string;
  /** The run's ORIGINAL deadline; a resume never gets a fresh clock. */
  executionDeadlineAt: number;
};

export type PreparedSuiteResume = {
  suiteId: string;
  runId: string;
  /** Rows this execution will run (0 ⇒ nothing left to do). */
  resumeIterationCount: number;
  execute: () => Promise<void>;
  cleanup: () => Promise<void>;
};

export class EvalResumeUnavailableError extends Error {
  override readonly name = "EvalResumeUnavailableError";
}

export async function prepareSuiteResumeFromRun(
  params: PrepareSuiteResumeParams,
): Promise<PreparedSuiteResume> {
  const {
    convexClient,
    convexAuthToken,
    runId,
    driverToken,
    executionDeadlineAt,
  } = params;
  const convexHttpUrl = requireConvexHttpUrl();

  const replayMetadata = await convexClient.query(
    "testSuites:getRunReplayMetadata" as any,
    { runId },
  );
  if (!replayMetadata?.hasServerReplayConfig) {
    // Without the run's own server configs there is nothing to reconnect
    // to; re-deriving them from the live suite would run a different set.
    throw new EvalResumeUnavailableError(
      "This run has no stored server configuration to resume with",
    );
  }
  const replayConfig = await fetchReplayConfig(runId, convexAuthToken);
  if (!replayConfig || replayConfig.servers.length === 0) {
    throw new EvalResumeUnavailableError(
      "No server configuration found for this run",
    );
  }
  const toolPolicy = await recoverToolPolicyFromSourceRun({
    convexClient,
    sourceRunId: runId,
  });

  const manager = buildReplayManager(replayConfig);
  try {
    // An expired OAuth token in the stored config fails HERE, before any row
    // is claimed — the worker reports it and the backend parks the run.
    await connectReplayManagerServers(manager, replayConfig);
    const serverIds = replayConfig.servers.map((server) => server.serverId);

    const started = await startSuiteRunWithRecorder({
      convexClient,
      suiteId: replayMetadata.suiteId,
      serverIds,
      resumeRunId: runId,
      // Never written: a resume starts no run. Only satisfies the type.
      source: "schedule",
    });
    const hostConfig =
      started.hostConfig ??
      (await loadSuiteHostConfig(convexClient, replayMetadata.suiteId));

    // The run's frozen skills, exactly as the launch path builds them.
    const pluginServers = await resolveSuiteRunPluginServers(
      () => convexClient,
      { runId, allowUndeployedBackend: !started.environmentRef },
    );
    const pins = await fetchRunPinnedSkillsWithRetry(convexClient, runId);
    const skills = await buildPinnedSkillSource({
      pins: pins ?? [],
      pluginVersions: started.pluginVersions ?? [],
      pluginServers,
      effectiveServerIds: serverIds,
    });
    const config = withPluginExecutionServers(
      started.config,
      pluginServers,
      manager,
    );

    const projectId =
      typeof replayMetadata.projectId === "string"
        ? replayMetadata.projectId
        : undefined;
    const orgModelConfigTarget = projectId ? { projectId } : undefined;
    let orgModelConfig: ResolvedOrgModelConfig | undefined;
    if (orgModelConfigTarget) {
      try {
        orgModelConfig = await resolveOrgModelConfig(orgModelConfigTarget, {
          bearerToken: convexAuthToken,
          serverIds,
        });
      } catch (error) {
        logger.warn("[eval-resume] could not resolve org model config", {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const resumeIterations = started.resumeIterations ?? [];
    return {
      suiteId: replayMetadata.suiteId,
      runId,
      resumeIterationCount: resumeIterations.length,
      execute: async () => {
        await runEvalSuiteWithAiSdk({
          suiteId: replayMetadata.suiteId,
          runId,
          config,
          ...(started.executionBudgets
            ? { executionBudgets: started.executionBudgets }
            : {}),
          orgModelConfig,
          orgModelConfigTarget,
          convexClient,
          convexHttpUrl,
          convexAuthToken,
          mcpClientManager: manager,
          recorder: started.recorder,
          suiteInjectOpenAiCompat: resolveOpenAiCompatForHostConfig(hostConfig),
          hostExecutionPolicy: extractHostExecutionPolicy(hostConfig),
          suiteHostConfig: hostConfig,
          // Harness runs are never resumable in v1, so this is always hosted.
          harnessRuntimeVenue: started.harnessRuntimeVenue,
          gradingMode: resolveFrozenRunGradingMode(started.gradingEngine),
          ...(started.environmentRef?.environmentId
            ? { projectEnvironmentId: started.environmentRef.environmentId }
            : {}),
          ...(skills.pinnedSkillSource
            ? { pinnedSkillSource: skills.pinnedSkillSource }
            : {}),
          pinnedHarnessSkills: skills.pinnedHarnessSkills,
          ...(toolPolicy ? { toolPolicy } : {}),
          ...(started.toolDescriptionOverride
            ? { toolDescriptionOverride: started.toolDescriptionOverride }
            : {}),
          resumeDriverToken: driverToken,
          resumeExecutionDeadlineAt: executionDeadlineAt,
          resumeIterations,
        });
      },
      cleanup: () => manager.disconnectAllServers(),
    };
  } catch (error) {
    await manager.disconnectAllServers().catch(() => {});
    throw error;
  }
}
