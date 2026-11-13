/**
 * Handing a parked local runtime to the turn that continues it: a runtime
 * parked on an approval, to the turn delivering the decision, or a Codex
 * runtime kept at the end of a turn, to the conversation's next turn
 * (`approval-park.ts`). Both run the same checks after their claim.
 */
import { logger } from "../../logger.js";
import {
  revokeHarnessModelBroker,
  startLoopbackModelBroker,
} from "../harness-model-broker.js";
import {
  claimLocalTurnPark,
  claimParkedLocalSession,
  invalidateParkedLocalSession,
  type ParkedLocalSession,
  type ParkInvalidationReason,
  type TurnParkRefusal,
} from "./approval-park.js";
import { resolveLocalHarnessAvailability } from "./availability.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
import type {
  LocalHarnessTurnPreparation,
  PrepareLocalHarnessTurnArgs,
  PreparedLocalHarnessTurn,
} from "./local-turn.js";
import {
  isTerminalInstallStatus,
  readRuntimeInstallStatus,
  type RuntimeInstallStatus,
} from "./runtime-install.js";
import { localRuntime } from "./runtimes/index.js";
import { revalidateRuntime } from "./runtime-identity.js";
import type { SupportedLocalHarnessId } from "./targets.js";
import { takeTurnRuntimeStatus } from "./turn-runtime-status.js";

/** A live local runtime, as a park holds it. */
export interface LiveLocalRuntime {
  prepared: PreparedLocalHarnessTurn;
  userId: string;
  projectId: string;
  runtimeId: string;
  workspaceGrantId: string;
  /** The pack it runs, as its turn selected it. */
  runtimeDigest: string;
  /** Bind a fresh lease to the SAME gateway (same port, same capability). */
  rebindLease: (next: { runId: string; lease: string; bearer: string; getCleanupAuthorization?: () => Promise<string> }) => void;
  revokeCurrentLease: () => Promise<void>;
  /** A fresh wall-clock budget for the turn that adopts it. */
  restartWallClock: () => void;
}

/**
 * Is the pack a kept runtime runs still the one a fresh turn would select,
 * with no install in flight for its harness? An update or a repair that may
 * replace that pack ends the runtime rather than wait behind it.
 */
export function runtimeStillSelected(status: RuntimeInstallStatus, digest: string): boolean {
  return (
    status.state === "ready" &&
    status.digest === digest &&
    (status.update === undefined || isTerminalInstallStatus(status.update))
  );
}

/** Hand a runtime parked on an approval to the turn delivering the decision. */
export async function adoptParkedLocalTurn(
  args: PrepareLocalHarnessTurnArgs,
  harnessId: SupportedLocalHarnessId,
  continuation: NonNullable<PrepareLocalHarnessTurnArgs["approvalContinuation"]>,
): Promise<LocalHarnessTurnPreparation> {
  const claim = claimParkedLocalSession<LiveLocalRuntime>({
    sessionId: args.sessionId,
    generation: continuation.generation,
    userId: args.target.actingUserId,
    projectId: args.projectId,
    approvalIds: continuation.approvalIds,
  });
  if (!claim.ok) {
    return { ok: false, status: `approval-${claim.reason}`, message: claim.message };
  }
  return adoptParkedRuntime(args, harnessId, claim.parked, false);
}

const TURN_PARK_ENDS: Record<Exclude<TurnParkRefusal, "absent" | "terminal">, ParkInvalidationReason> = {
  "not-idle": "superseded",
  "actor-mismatch": "superseded",
  stale: "superseded",
  "configuration-changed": "configuration-changed",
  lifetime: "lifetime",
  "process-died": "process-died",
};

/**
 * Hand the runtime this conversation's last turn kept to its next turn: only
 * for the generation and state version the lane's committed state names, and
 * the same configuration. A refusal ends the park (the registry logs why) and
 * is not for display: the caller starts the turn fresh, as before.
 */
export async function adoptKeptLocalTurn(
  args: PrepareLocalHarnessTurnArgs,
  harnessId: SupportedLocalHarnessId,
): Promise<LocalHarnessTurnPreparation> {
  const kept = args.keptRuntime;
  const claim = kept?.committed === undefined
    ? ({ ok: false, reason: "stale" } as const)
    : claimLocalTurnPark<LiveLocalRuntime>({
        sessionId: args.sessionId,
        generation: kept.committed.generation,
        stateVersion: kept.committed.stateVersion,
        fingerprint: kept.fingerprint,
        userId: args.target.actingUserId,
        projectId: args.projectId,
      });
  if (!claim.ok) {
    if (claim.reason !== "absent" && claim.reason !== "terminal") {
      await invalidateParkedLocalSession(args.sessionId, TURN_PARK_ENDS[claim.reason]);
    }
    return { ok: false, status: `kept-${claim.reason}`, message: "The kept runtime was not adopted." };
  }
  return adoptParkedRuntime(args, harnessId, claim.parked, true);
}

/**
 * After a claim, which is synchronous and exactly-once (`approval-park.ts`),
 * everything re-establishes AUTHORITY rather than assuming it survived the
 * wait: the availability gate runs again (kill switch, actor, consent,
 * workspace, a selectable pack), the parked process's own pack is re-verified
 * on disk, and the model lease, revoked when it parked, is replaced by a
 * fresh one bound to the gateway the process already knows. Any failure ends
 * the parked session: a decision that cannot be delivered under current
 * authority is not delivered at all. Refusals are worded for that decision,
 * the one kind of refusal a person reads.
 */
async function adoptParkedRuntime(
  args: PrepareLocalHarnessTurnArgs,
  harnessId: SupportedLocalHarnessId,
  parked: ParkedLocalSession<LiveLocalRuntime>,
  kept: boolean,
): Promise<LocalHarnessTurnPreparation> {
  const live = parked.resources;
  live.prepared.sandbox.forbidNewProcesses(
    kept ? "The agent kept for this chat stopped before it could answer. Send your message again." : undefined,
  );
  const fail = async (
    reason: ParkInvalidationReason,
    status: string,
    message: string,
  ): Promise<LocalHarnessTurnPreparation> => {
    await invalidateParkedLocalSession(args.sessionId, reason);
    return { ok: false, status, message };
  };
  const verifyStartedAt = Date.now();

  // A kept runtime is held to what a fresh turn would select now; readiness
  // hands over that selection, made with no preference, for this target.
  const runtimeStatus = takeTurnRuntimeStatus(args.target) ?? await readRuntimeInstallStatus({
    harnessId,
    ...(kept ? {} : { preferRuntimeId: args.target.runtimeId }),
  });
  if (runtimeStatus.state !== "ready") {
    return fail(
      kept ? "runtime-update" : "authorization-revoked",
      "runtime-unavailable",
      "The local runtime holding this approval is no longer installed; the " +
        "pending action will not run.",
    );
  }
  if (kept && !runtimeStillSelected(runtimeStatus, live.runtimeDigest)) {
    return fail("runtime-update", "runtime-update", "The local runtime changed or is being updated.");
  }
  const availability = await resolveLocalHarnessAvailability({
    target: {
      kind: "local-native",
      harnessId,
      machineId: args.target.machineId,
      workspaceGrantId: args.target.workspaceGrantId,
      runtimeId: args.target.runtimeId,
      permissionProfile: args.target.permissionProfile,
      policyVersion: args.target.policyVersion,
    },
    actor: args.actor,
    scope: args.scope,
    userId: args.target.actingUserId,
    projectId: args.projectId,
    grantToken: args.target.grantToken,
    runtimeRoot: runtimeStatus.runtimeRoot,
    runtimeDigest: runtimeStatus.digest,
    installedAdapterVersion:
      args.installedAdapterVersion ??
      localRuntime(harnessId).installedAdapterVersion(),
    // The parked process's own pack is re-verified below, once it is known
    // to be the runtime this turn names.
    runtimeVerifiedAtSpawn: true,
  });
  if (!availability.available) {
    return fail("authorization-revoked", availability.status, availability.message);
  }
  const plan = availability.plan;
  // The parked process runs ONE runtime against ONE workspace. A decision
  // re-authorized for anything else is not a decision about this process.
  if (
    plan.runtime.runtimeId !== live.runtimeId ||
    plan.target.workspaceGrantId !== live.workspaceGrantId
  ) {
    return fail(
      "authorization-revoked",
      "approval-runtime-changed",
      "The runtime or workspace changed while this approval was waiting; " +
        "the pending action will not run.",
    );
  }
  // Not "verified once at spawn": the bridge starts a new vendor process from
  // this pack when its runtime configuration changes or the app-server dies.
  if (!(await revalidateRuntime(live.prepared.plan.runtime)).ok) {
    return fail(
      "authorization-revoked",
      "runtime-changed",
      "The local runtime changed on disk while this approval was waiting; " +
        "the pending action will not run.",
    );
  }
  const permissionMode = args.scope !== "unattended" || args.requireToolApproval
    ? ("allow-reads" as const)
    : plan.permissionMode;
  if (permissionMode !== live.prepared.permissionMode) {
    return fail(
      "authorization-revoked",
      "approval-permission-changed",
      "The permission this session was approved under changed while the " +
        "approval was waiting; the pending action will not run.",
    );
  }

  const identity = await readLocalInstanceIdentity();
  const keyId = identity.keyId ?? getRegisteredKeyId();
  if (keyId === null) {
    return fail(
      "authorization-revoked",
      "consent-required",
      "This installation is no longer registered for local execution.",
    );
  }
  const gatewayStartedAt = Date.now();
  const broker = await startLoopbackModelBroker({
    projectId: args.projectId,
    evalIterationId: args.evalIterationId,
    journeyRunId: args.journeyRunId,
    targetId: args.targetId,
    sessionIdx: args.sessionIdx,
    hostId: args.hostId,
    harnessId: args.harnessId,
    modelId: args.modelId,
    machineId: identity.machineId,
    keyId,
    runId: args.runId,
    ...(args.maxOutputTokens !== undefined
      ? { maxOutputTokens: args.maxOutputTokens }
      : {}),
    // A kept runtime's next turn is a new turn, with its own effort; a
    // decision continues the turn that paused.
    ...(kept && args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    // The re-adopted runtime keeps running on the same organization key it
    // started on; a key replaced while the approval waited fails the
    // renewal rather than silently switching accounts under a live session.
    ...(args.modelSelection ? { modelSelection: args.modelSelection } : {}),
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!broker.ok) {
    return fail("renewal-failed", "broker-unavailable", broker.error);
  }
  if (
    live.prepared?.orgUpstream &&
    broker.orgUpstream?.credentialRevision !==
      live.prepared.orgUpstream.credentialRevision
  ) {
    await revokeLease(broker.runId, args.bearer);
    return fail(
      "renewal-failed",
      "byok-connection-changed",
      "The organization's provider key was replaced while the approval was " +
        "waiting; the pending action will not run.",
    );
  }
  // The awaits above are a window in which the parked tree can die or a Stop
  // can land. Re-check before binding the fresh lease: delivering the decision
  // to a bridge that had to be respawned could approve an action nobody saw.
  if (parked.state !== "continuing" || !parked.isAlive()) {
    await revokeLease(broker.runId, args.bearer);
    return fail(
      "process-died",
      "approval-process-died",
      "The local runtime holding this approval stopped while the decision " +
        "was being delivered; the pending action will not run.",
    );
  }
  try {
    live.rebindLease({ runId: broker.runId, lease: broker.lease, bearer: args.bearer, getCleanupAuthorization: args.getCleanupAuthorization });
  } catch (error) {
    await revokeLease(broker.runId, args.bearer);
    return fail(
      "renewal-failed",
      "gateway-unavailable",
      `The renewed model lease could not be bound: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (kept) live.restartWallClock();
  logger.info(
    kept
      ? "[local-harness] kept runtime adopted for the next turn"
      : "[local-harness] parked session re-adopted for an approval",
    {
      sessionId: args.sessionId,
      ...(args.approvalContinuation ? { approvals: args.approvalContinuation.approvalIds.length } : {}),
    },
  );
  return {
    ok: true,
    prepared: {
      ...live.prepared,
      plan,
      sessionStateExists: true,
      brokerRunId: broker.runId,
      ...(broker.orgUpstream ? { orgUpstream: broker.orgUpstream } : {}),
      timings: {
        localRuntimeVerifyMs: gatewayStartedAt - verifyStartedAt,
        localGatewayReadyMs: Date.now() - gatewayStartedAt,
      },
      ...(kept ? { keptRuntime: true } : {}),
    },
  };
}

/** Best-effort revoke of a lease by its run id. */
export async function revokeLease(runId: string, authorization: string | (() => Promise<string>)): Promise<void> {
  try {
    const bearer = typeof authorization === "string" ? authorization : await authorization();
    await revokeHarnessModelBroker({ runId, bearer });
  } catch (error) {
    // Best-effort, exactly as the cloud path's revoke is: the lease's own TTL
    // and the backend's sweep are the backstop, and the gateway is already
    // refusing everything by the time this runs.
    logger.warn("[local-harness] lease revoke failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
