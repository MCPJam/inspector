import type { ModelDefinition } from "../../../shared/types";
import {
  GROUNDING_LIMITS,
  mayRunAfterSetup,
  type SetupRecord,
} from "../../../shared/swarm-grounding";
import {
  reportTargetGrounding,
  type PersonaSnapshot,
  type PinnedHostExecutionSpec,
} from "../swarm-agent";
import { logger } from "../../utils/logger";
import { withDeadline } from "../../utils/run-supervisor/deadline";
import type { JourneyManagerFactory } from "./swarm-runner";
import { abortable, probeReadOnlyTools } from "./target-discovery";
import { runSwarmSetupTurn, SwarmSetupError } from "./swarm-setup-turn";
import {
  isStarterStepRejected,
  STARTER_STEP_REJECTED_ERROR_CODE,
} from "../../../shared/swarm-attempt-error";
import { spendRefusalOf } from "./admission-retry";

/** A grounding call the backend refused as `swarm_starter_rejected`. */
function isRejectedStarterStep(error: unknown): boolean {
  return isStarterStepRejected(
    spendRefusalOf(error)?.code,
    error instanceof Error ? error.message : undefined,
  );
}
export async function prepareTargetGrounding(args: {
  runId: string;
  projectId: string;
  target: PinnedHostExecutionSpec;
  persona: PersonaSnapshot;
  goal?: string;
  setupWrites?: boolean;
  modelDefinition: ModelDefinition;
  managerFactory: JourneyManagerFactory;
  convexHttpUrl: string;
  bearer: string;
  signal: AbortSignal;
  /** The target's first claim confirmed starter; see `runSwarmSetupTurn`. */
  starterFunded?: boolean;
}) {
  if (!args.target.targetId || args.signal.aborted) return;
  const identity = {
    projectId: args.projectId,
    runId: args.runId,
    targetId: args.target.targetId,
    hostId: args.target.hostId,
  };
  let setup: SetupRecord | undefined;
  /** Answers `rejected` when the backend refused the call as a starter step. */
  const report = async (
    body: Parameters<typeof reportTargetGrounding>[2],
  ): Promise<"rejected" | undefined> => {
    if (args.signal.aborted) return;
    try {
      await reportTargetGrounding(
        args.convexHttpUrl,
        args.bearer,
        body,
        args.signal,
      );
    } catch (error) {
      if (isRejectedStarterStep(error)) {
        logger.warn("[swarm.runner] target grounding starter step rejected", {
          ...identity,
          reason: STARTER_STEP_REJECTED_ERROR_CODE,
        });
        return "rejected";
      }
      logger.warn(
        "[swarm.runner] target grounding report unavailable",
        identity,
      );
    }
  };
  // A grounding call refused as a starter step ends the grounding with that
  // reason, exactly as a refused setup does: it is recorded once, without
  // probes, and neither the call nor the discovery runs again. It is not a
  // credits problem and does not stop the target's sessions, which read-only
  // grounding never gates.
  const reportRejected = (probedTools: string[]) =>
    report({
      ...identity,
      probes: [],
      probedTools,
      skippedReason: STARTER_STEP_REJECTED_ERROR_CODE,
      ...(setup?.createdEntities.length
        ? { seedFacts: setup.createdEntities }
        : {}),
    });
  if (args.setupWrites) {
    const setupArgs = { ...args, authHeader: `Bearer ${args.bearer}` };
    try {
      setup = await runSwarmSetupTurn(setupArgs);
    } catch (error) {
      if (!(error instanceof SwarmSetupError)) throw error;
      setup = error.partial;
      // A rejected starter step is the backend's answer for this setup, not
      // a transport blip: running it again cannot be authorized either.
      if (
        !args.signal.aborted &&
        setup.writeCallsDispatched === 0 &&
        setup.reason !== STARTER_STEP_REJECTED_ERROR_CODE
      ) {
        try {
          setup = await runSwarmSetupTurn({ ...setupArgs, retried: true });
        } catch (retryError) {
          if (!(retryError instanceof SwarmSetupError)) throw retryError;
          setup = retryError.partial;
        }
      }
    }
    await report({ ...identity, setup });
    if (args.signal.aborted) return;
    if (!mayRunAfterSetup(setup)) throw new SwarmSetupError(setup);
  }
  const deadline = withDeadline(
    args.signal,
    GROUNDING_LIMITS.totalMs,
    "discovery",
  );
  let connection: Awaited<ReturnType<JourneyManagerFactory>> | undefined;
  logger.info("target.discovery.start", identity);
  try {
    connection = await abortable(
      args.managerFactory(args.target).then(async (built) => {
        if (deadline.signal.aborted) {
          await built.dispose();
          throw deadline.signal.reason;
        }
        return built;
      }),
      deadline.signal,
    );
    if (!connection) throw new Error("Target connection unavailable");
    const discovery = await probeReadOnlyTools({
      manager: connection.manager,
      serverIds: connection.connectedServerIds,
      serverNames: connection.connectedServerNames,
      signal: deadline.signal,
    });
    if (args.signal.aborted) return;
    const outcome = await report({
      ...identity,
      ...discovery,
      ...(setup?.createdEntities.length
        ? { seedFacts: setup.createdEntities }
        : {}),
    });
    if (outcome === "rejected") await reportRejected(discovery.probedTools);
    logger.info("target.discovery.finish", identity);
  } catch (error) {
    if (!args.signal.aborted && isRejectedStarterStep(error)) {
      await reportRejected([]);
    } else if (!args.signal.aborted) {
      const outcome = await report({
        ...identity,
        probes: [],
        probedTools: [],
        skippedReason: "connect_failed",
        ...(setup?.createdEntities.length
          ? { seedFacts: setup.createdEntities }
          : {}),
      });
      if (outcome === "rejected") await reportRejected([]);
      logger.info("target.discovery.skipped", identity);
    }
  } finally {
    deadline.dispose();
    await connection?.dispose().catch(() => {});
  }
}
