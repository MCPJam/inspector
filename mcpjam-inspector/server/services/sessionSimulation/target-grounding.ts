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
}) {
  if (!args.target.targetId || args.signal.aborted) return;
  const identity = {
    projectId: args.projectId,
    runId: args.runId,
    targetId: args.target.targetId,
    hostId: args.target.hostId,
  };
  let setup: SetupRecord | undefined;
  const report = async (body: Parameters<typeof reportTargetGrounding>[2]) => {
    if (args.signal.aborted) return;
    try {
      await reportTargetGrounding(
        args.convexHttpUrl,
        args.bearer,
        body,
        args.signal,
      );
    } catch {
      logger.warn(
        "[swarm.runner] target grounding report unavailable",
        identity,
      );
    }
  };
  if (args.setupWrites) {
    const setupArgs = { ...args, authHeader: `Bearer ${args.bearer}` };
    try {
      setup = await runSwarmSetupTurn(setupArgs);
    } catch (error) {
      if (!(error instanceof SwarmSetupError)) throw error;
      setup = error.partial;
      if (!args.signal.aborted && setup.writeCallsDispatched === 0) {
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
    await report({
      ...identity,
      ...discovery,
      ...(setup?.createdEntities.length
        ? { seedFacts: setup.createdEntities }
        : {}),
    });
    logger.info("target.discovery.finish", identity);
  } catch {
    if (!args.signal.aborted) {
      await report({
        ...identity,
        probes: [],
        probedTools: [],
        skippedReason: "connect_failed",
        ...(setup?.createdEntities.length
          ? { seedFacts: setup.createdEntities }
          : {}),
      });
      logger.info("target.discovery.skipped", identity);
    }
  } finally {
    deadline.dispose();
    await connection?.dispose().catch(() => {});
  }
}
