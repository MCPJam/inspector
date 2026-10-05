import { readLocalHarnessAuthorization } from "./authorization.js";
/**
 * Everything a turn needs to run on the user's own machine, behind ONE call.
 *
 * ── Why this module exists rather than a branch per step ─────────────────
 * `runHarnessTurn` is long, and every step of its cloud path — reserve a box,
 * wake it, install an egress transform, lease against a computer id — has a
 * local answer that is not "the same thing with a flag". Threading a
 * conditional through each would leave the two paths interleaved and neither
 * legible.
 *
 * So the local path is assembled here and handed back in the shape the turn
 * already consumes: a sandbox provider, an auth bag, a working directory, and a
 * teardown. `runHarnessTurn` branches once.
 *
 * ── The order these steps must happen in ─────────────────────────────────
 *  1. availability — the single chokepoint. Kill switch, actor, compatibility,
 *     workspace grant, runtime identity, consent, each re-derived rather than
 *     taken from the caller. A refusal here is the whole answer.
 *  2. the lease — obtained BEFORE anything is spawned, because a supervised
 *     tree with no credential is a process running for nothing.
 *  3. the gateway — bound before the provider, because the provider's
 *     environment names it.
 *  4. the provider — which starts the supervisor's bridge on first use.
 *
 * Teardown runs in the reverse order and never skips a step because an earlier
 * one failed: a gateway left listening with a live lease is a credential nobody
 * is watching.
 */
import { logger } from "../../logger.js";
import type { HarnessAuth, HarnessId } from "../registry.js";
import type { ModelReasoningEffort } from "@mcpjam/sdk/browser";
import {
  revokeHarnessModelBroker,
  startLoopbackModelBroker,
} from "../harness-model-broker.js";
import {
  resolveLocalHarnessAvailability,
  type LocalHarnessActor,
  type LocalHarnessLaunchPlan,
} from "./availability.js";
import { resolveNodeLauncher } from "./node-launcher.js";
import {
  startLocalModelGateway,
  type LocalModelGateway,
} from "./model-gateway.js";
import { readRuntimeInstallStatus } from "./runtime-install.js";
import {
  reserveRuntimeUse,
  type RuntimeOperationKey,
  type RuntimeUseReservation,
} from "./runtime-lifecycle.js";
import { runtimeInstallRoot } from "./runtime-install.js";
import {
  localPackTarget,
  SUPPORTED_LOCAL_HARNESS_IDS,
  type SupportedLocalHarnessId,
} from "./targets.js";
import {
  claimParkedLocalSession,
  hasParkedLocalSession,
  invalidateParkedLocalSession,
  noteParkedLocalSessionEnded,
  parkLocalSession,
  releaseParkedLocalSession,
  type ParkInvalidationReason,
} from "./approval-park.js";
import { CODEX_LOCAL_ADAPTER_IDENTITY } from "../codex-appserver/local-identity.js";
import {
  createSupervisedLocalHarnessProvider,
  removeSessionStateDir,
  sessionStateDirFor,
} from "./supervised-provider.js";
import { LocalHarnessSupervisor } from "./supervisor.js";
import { localHarnessStateRoot } from "./grants.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
import {
  endLocalHarnessSession,
  forgetLocalHarnessSession,
  forgetLocalHarnessSessionRecord,
  registerLocalHarnessSession,
  getLocalHarnessSession,
  type LocalHarnessSessionRecord,
} from "./session-registry.js";
import { join } from "node:path";
import { toAdapterPath } from "./adapter-path.js";
import { validateLocalHarnessSecretEnv } from "./session-env.js";
import { mkdir, stat } from "node:fs/promises";
import { reserveLoopbackPort } from "./bridge-endpoint.js";
import { createRequire } from "node:module";

/**
 * The turn's declared local target — opaque ids only.
 *
 * Every one of these is re-derived or re-verified by the availability gate; the
 * caller states which target it means, not what that target is allowed to do.
 */
export interface LocalHarnessExecutionTarget {
  kind: "local-native";
  workspaceGrantId: string;
  runtimeId: string;
  machineId: string;
  permissionProfile: "read-only" | "workspace-edits" | "unrestricted";
  policyVersion: string;
  /** Plaintext consent capability from the request header. NEVER persisted. */
  grantToken: string;
  /** The acting user, resolved by the route from the verified bearer. */
  actingUserId: string;
  /** Server scheduler-owned session identity; never parsed from renderer input. */
  localSessionId?: string;
  targetId?: string;
  sessionIdx?: number;
}

export interface PreparedLocalHarnessTurn {
  plan: LocalHarnessLaunchPlan;
  /** The AI SDK sandbox provider the turn assembles its harness over. */
  sandbox: ReturnType<typeof createSupervisedLocalHarnessProvider>;
  /** What the child gets: a gateway URL and a per-session capability. */
  auth: HarnessAuth;
  /**
   * The agent's working directory, RELATIVE to the provider's default.
   *
   * Always `project` — the symlink into the granted workspace. The framework
   * refuses "." and refuses an absolute path, and pointing it at the workspace
   * directly is what put bridge state inside the user's checkout.
   */
  sandboxWorkDir: string;
  /** Adapter-facing path under the session's synthetic HOME. */
  skillsBaseDir: string;
  /** Observed before preparation creates the directory; a sidecar alone is insufficient. */
  sessionStateExists: boolean;
  permissionMode: "allow-reads" | "allow-edits" | "allow-all";
  brokerRunId: string;
  /** Fields for the turn's timing telemetry. Durations, never paths. */
  timings: {
    localRuntimeVerifyMs: number;
    localGatewayReadyMs: number;
  };
  /** Idempotent. Revokes the gateway, revokes the lease, stops the tree. */
  teardown: () => Promise<void>;
  /** End the lane: remove private state only after a proven process stop. */
  discardState: () => Promise<void>;
  /**
   * Park this live runtime on a human approval instead of tearing it down
   * (`approval-park.ts`). Holds model traffic and revokes the lease now; the
   * tree, bridge, relay and gateway port stay up until a decision, a Stop, the
   * idle TTL or a process death. Returns false when it could not park (the
   * session was ended meanwhile) — the caller then tears down as usual.
   *
   * Only meaningful for a harness whose pending approval lives in the process
   * (Codex app-server). After a successful park the caller must NOT run
   * `teardown`: the parked record owns cleanup from here.
   */
  park: (args: {
    /** The live process generation: the bridge token of the suspended turn. */
    generation: string;
    pendingApprovalIds: readonly string[];
    ttlMs?: number;
  }) => boolean;
  /** A continuation finished without pausing again: give cleanup back to
   *  this turn's own teardown. No-op when nothing was parked. */
  unpark: () => void;
}

export type LocalHarnessTurnPreparation =
  | { ok: true; prepared: PreparedLocalHarnessTurn }
  | { ok: false; status: string; message: string };

/**
 * ONE supervisor per process, not per turn.
 *
 * The supervisor owns the durable process registry and the janitor that
 * reclaims trees orphaned by a crash. Two of them in one process would each
 * see the other's records as orphans and reclaim trees that are very much
 * alive.
 */
let sharedSupervisor: LocalHarnessSupervisor | null = null;

export function localHarnessSupervisor(): LocalHarnessSupervisor {
  sharedSupervisor ??= new LocalHarnessSupervisor();
  return sharedSupervisor;
}

export interface PrepareLocalHarnessTurnArgs {
  target: LocalHarnessExecutionTarget;
  harnessId: HarnessId;
  modelId: string;
  sessionId: string;
  runId: string;
  evalIterationId?: string;
  journeyRunId?: string;
  targetId?: string;
  sessionIdx?: number;
  hostId?: string;
  actor: LocalHarnessActor;
  projectId: string;
  /**
   * Installed adapter version. Omitted, it is read from the installed package —
   * which is where it has to come from, because the manifest's pin exists to be
   * compared against what is ACTUALLY installed.
   */
  installedAdapterVersion?: string;
  /** The user's bearer, for the lease start. Never persisted here. */
  bearer: string;
  /** Attended Off requires durable consent; unattended modes keep their mapping. */
  requireToolApproval?: boolean;
  /**
   * Set when this turn delivers decisions to an approval a LIVE runtime is
   * parked on. The parked runtime is re-adopted — authorization re-checked, a
   * fresh lease bound to the same gateway — instead of starting a new tree;
   * and if it is gone, the turn is refused rather than replayed.
   */
  approvalContinuation?: {
    /** The bridge token recorded with the suspended turn. */
    generation: string;
    approvalIds: readonly string[];
  };
  scope?: "attended" | "unattended";
  /** Materialized project secrets; runtime-owned credential names are refused. */
  scopedEnv?: Readonly<Record<string, string>>;
  onSecretEnvDelivered?: () => void;
  maxOutputTokens?: number;
  /** The turn's reasoning effort, carried on the lease start. */
  reasoningEffort?: ModelReasoningEffort;
  signal?: AbortSignal;
}

/** What a user calls each local harness, for refusals they read. */
const LOCAL_HARNESS_DISPLAY_NAME: Readonly<Record<SupportedLocalHarnessId, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

function asLocalHarnessId(harnessId: string): SupportedLocalHarnessId | null {
  return (SUPPORTED_LOCAL_HARNESS_IDS as readonly string[]).includes(harnessId)
    ? (harnessId as SupportedLocalHarnessId)
    : null;
}

/**
 * The child's model credential: the gateway, and a capability that means
 * nothing anywhere else. The lease is not in here and never will be.
 *
 * Codex's `OPENAI_BASE_URL` is the gateway's BARE origin — no `/v1`. Codex
 * appends `/responses` to the base URL, and the gateway forwards exactly
 * `POST /responses` under the broker's own OpenAI base path.
 */
function localChildAuth(
  harnessId: SupportedLocalHarnessId,
  gateway: Pick<LocalModelGateway, "baseUrl" | "sessionCapability">,
): HarnessAuth {
  switch (harnessId) {
    case "claude-code":
      return {
        ANTHROPIC_AUTH_TOKEN: gateway.sessionCapability,
        ANTHROPIC_API_KEY: gateway.sessionCapability,
        ANTHROPIC_BASE_URL: gateway.baseUrl,
      } as HarnessAuth;
    case "codex":
      return {
        CODEX_API_KEY: gateway.sessionCapability,
        OPENAI_BASE_URL: gateway.baseUrl,
      } as HarnessAuth;
  }
}

/** Where each harness reads skills, under the session's synthetic HOME. */
const LOCAL_SKILLS_SUBDIR: Readonly<Record<SupportedLocalHarnessId, readonly string[]>> = {
  "claude-code": [".claude", "skills"],
  codex: [".agents", "skills"],
};

export async function prepareLocalHarnessTurn(
  args: PrepareLocalHarnessTurnArgs,
): Promise<LocalHarnessTurnPreparation> {
  const harnessId = asLocalHarnessId(args.harnessId);
  if (harnessId === null) {
    return {
      ok: false,
      status: "harness-not-supported",
      message: `${args.harnessId} cannot run on this machine.`,
    };
  }
  validateLocalHarnessSecretEnv(args.scopedEnv ?? {}, harnessId);
  const displayName = LOCAL_HARNESS_DISPLAY_NAME[harnessId];

  // A decision for an approval a live runtime is parked on: hand that runtime
  // to this turn, or refuse. Never replay the approval into a fresh process.
  if (args.approvalContinuation) {
    return adoptParkedLocalTurn(args, harnessId);
  }
  // A NEW prompt on a session still parked on an approval supersedes the
  // pending decision: the action it was waiting on will not run, and the
  // conversation continues from disk in a fresh process.
  if (hasParkedLocalSession(args.sessionId)) {
    await invalidateParkedLocalSession(args.sessionId, "superseded");
  }
  if (args.scope !== "unattended" && args.requireToolApproval === false) {
    const authorization = await readLocalHarnessAuthorization(args.target.actingUserId, args.target.machineId, args.projectId, harnessId);
    if (!authorization?.autoApproveAcknowledgedAt) {
      return { ok: false, status: "auto-approve-consent-required", message: "Allow commands without asking before turning Tool Approval off on this computer." };
    }
  }
  const verifyStartedAt = Date.now();

  // The pack's install root is where availability looks for a runtime. Reading
  // it from the installer rather than a constant means the Electron override
  // and the npx default cannot disagree.
  const runtimeStatus = await readRuntimeInstallStatus({ harnessId });
  if (runtimeStatus.state !== "ready") {
    return {
      ok: false,
      status: "runtime-unavailable",
      message:
        runtimeStatus.state === "absent"
          ? `The local ${displayName} runtime is not installed on this machine yet.`
          : `The local ${displayName} runtime is not usable (${runtimeStatus.state}).`,
    };
  }

  // ── Reserve the runtime BEFORE verifying it ──────────────────────────────
  //
  // Not after, and not at spawn. The window that has to be covered runs from
  // before the digest is read until after the last supervised child is dead: a
  // pack replaced anywhere inside it means this session verified one tree and
  // executed another. An install in another Inspector window, or the install
  // CLI, consults these reservations and refuses to replace a runtime that has
  // one — so taking it late is the same as not taking it.
  //
  // Released on every exit that is not a started session: a refusal returned
  // below, a throw, and — for a session that did start — the teardown that
  // runs when it ends.
  const target = localPackTarget();
  const lifecycleKey: RuntimeOperationKey | null =
    target === null
      ? null
      : {
          runtimeRoot: runtimeInstallRoot(),
          harnessId,
          target,
          packVersion: runtimeStatus.packVersion,
          treeDigest: runtimeStatus.digest,
        };
  let runtimeUse: RuntimeUseReservation | null = null;
  if (lifecycleKey !== null) {
    try {
      runtimeUse = await reserveRuntimeUse({
        key: lifecycleKey,
        runtimeRoot: runtimeStatus.runtimeRoot,
        label: args.sessionId,
      });
    } catch (error) {
      // A reservation that cannot be TAKEN is a refusal, not something to
      // shrug off. It is what stops another Inspector — or the install CLI —
      // replacing the tree this session's children are about to execute from,
      // so running without one means running unprotected, quietly.
      //
      // Refused as `runtime-unavailable` with the reason, rather than letting
      // an ENOSPC or an EACCES on a read-only runtime root escape as an
      // unhandled error out of turn preparation. The user sees what is wrong
      // with their machine instead of a stack trace.
      return {
        ok: false,
        status: "runtime-unavailable",
        message:
          "This Inspector could not reserve the local runtime, so it will " +
          "not start a session that another process could replace underneath: " +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const releaseRuntimeUse = async () => {
    const held = runtimeUse;
    runtimeUse = null;
    await held?.release();
  };

  try {
    const prepared = await prepareWithReservedRuntime({
      args,
      harnessId,
      runtimeStatus,
      verifyStartedAt,
      releaseRuntimeUse,
    });
    // Ownership passes to the session's teardown ONLY on success.
    //
    // A refusal is a RESOLVED value here, not a throw, so it never reaches the
    // `catch` below. Without this the reservation outlived every declined turn
    // — and it does not decay, because the owner it names is this live server
    // process. `activateVerifiedPack` then refuses to replace a version
    // directory that is "in use by N running session(s)", counting sessions
    // that never started, so one refused turn disabled reinstall and repair
    // for the rest of the process's life.
    if (!prepared.ok) await releaseRuntimeUse();
    return prepared;
  } catch (error) {
    await releaseRuntimeUse();
    throw error;
  }
}

/**
 * The body of `prepareLocalHarnessTurn`, with the runtime reservation held.
 *
 * Split out so every refusal path below is one `return` rather than a
 * `release(); return` pair that a later edit can forget one half of. The
 * caller releases the reservation for anything that is not a started session
 * — a resolved refusal as well as a throw — and only the success path hands
 * ownership of it to the session's teardown.
 */
async function prepareWithReservedRuntime(outer: {
  args: PrepareLocalHarnessTurnArgs;
  harnessId: SupportedLocalHarnessId;
  runtimeStatus: Extract<
    Awaited<ReturnType<typeof readRuntimeInstallStatus>>,
    { state: "ready" }
  >;
  verifyStartedAt: number;
  releaseRuntimeUse: () => Promise<void>;
}): Promise<LocalHarnessTurnPreparation> {
  const args = outer.args;
  const harnessId = outer.harnessId;
  const runtimeStatus = outer.runtimeStatus;
  const verifyStartedAt = outer.verifyStartedAt;
  // Validate before minting a lease, including ids recovered from a sidecar.
  const sessionStateDir = sessionStateDirFor(
    localHarnessStateRoot(),
    args.sessionId,
  );
  if (getLocalHarnessSession(args.sessionId)) {
    return {
      ok: false,
      status: "session-still-running",
      message:
        "The previous local turn is still stopping. Try again once it has stopped.",
    };
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
    // Server-derived, never from a request body: consent binds to a user, and
    // a user the caller names is a user the caller chose.
    userId: args.target.actingUserId,
    projectId: args.projectId,
    grantToken: args.target.grantToken,
    runtimeRoot: runtimeStatus.runtimeRoot,
    installedAdapterVersion:
      args.installedAdapterVersion ??
      (await readInstalledAdapterVersion(harnessId)),
  });
  if (!availability.available) {
    return {
      ok: false,
      status: availability.status,
      message: availability.message,
    };
  }
  const plan = availability.plan;
  const localRuntimeVerifyMs = Date.now() - verifyStartedAt;

  // Attended turns keep ask mode across toggle changes. Off is implemented
  // by answering native requests in MCPJam, rather than widening permissions.
  const permissionMode = args.scope !== "unattended" || args.requireToolApproval
    ? ("allow-reads" as const)
    : plan.permissionMode;

  // The lease FIRST. A supervised tree with no credential is a process running
  // for nothing, and one that discovers it mid-turn has already spent the
  // user's time.
  const identity = await readLocalInstanceIdentity();
  const keyId = identity.keyId ?? getRegisteredKeyId();
  if (keyId === null) {
    return {
      ok: false,
      status: "consent-required",
      message:
        "This installation is not registered for local execution yet. " +
        "Re-authorize local execution on this machine.",
    };
  }
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
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!broker.ok) {
    return {
      ok: false,
      status: "broker-unavailable",
      message: broker.error,
    };
  }

  const supervisor = localHarnessSupervisor();

  // From here the lease exists, and shortly a loopback listener that can spend
  // it. Every step below can fail — a state directory that will not create, a
  // port nothing will give up, a launcher that refuses the pack's node — and a
  // failure that escaped this stretch used to leave BOTH behind: no registry
  // record, so `stop-all` could not reach them, and no teardown, so only the
  // lease's own TTL would have ended it. The module header calls that "a
  // credential nobody is watching"; this is what makes the setup path obey it
  // too, not just the teardown path.
  let gateway: LocalModelGateway | null = null;
  // The lease the gateway currently forwards with. Mutable because a session
  // parked on an approval gets a FRESH lease when the decision arrives, bound
  // to the same gateway, and every revoke must hit the current one.
  let currentRunId = broker.runId;
  try {
    const sessionStateExists = await stat(sessionStateDir)
      .then((entry) => entry.isDirectory())
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
    await mkdir(sessionStateDir, { recursive: true, mode: 0o700 });

    const hooksPath = join(sessionStateDir, "empty-git-hooks");
    if (args.scope === "unattended") await mkdir(hooksPath, { recursive: true, mode: 0o700 });
    const gatewayStartedAt = Date.now();
    try {
      gateway = await startLocalModelGateway({
        lease: broker.lease,
        upstreamBaseUrl: broker.proxyBaseUrl,
        // The gateway serves only processes in this session's supervised tree.
        // Asked of the supervisor rather than captured as a pid set, because the
        // tree grows: the bridge spawns the vendor CLI after the gateway is
        // already listening.
        isSupervisedPid: (pid) => supervisor.ownsPid(args.sessionId, pid),
      });
    } catch (error) {
      // The lease exists and nothing can use it, so it is revoked before the
      // failure propagates rather than left to its TTL.
      await revokeLease(broker.runId, args.bearer);
      return {
        ok: false,
        status: "gateway-unavailable",
        message:
          "The local model gateway could not start: " +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const started = gateway;
    const localGatewayReadyMs = Date.now() - gatewayStartedAt;

    const bridgePort = await reserveLoopbackPort();
    const launcher = resolveNodeLauncher({
      // Inside the tree the digest just covered. The npx server's own execPath
      // is not, and Electron cannot be a launcher at all.
      bundledNodePath: plan.runtime.nodePath ?? "",
    });

    const sandbox = createSupervisedLocalHarnessProvider({
      harnessId,
      manifest: plan.manifest,
      runtime: plan.runtime,
      supervisor,
      launcher,
      workspacePath: plan.workspacePath,
      workspaceGrantId: plan.target.workspaceGrantId,
      sessionStateDir,
      ...(args.onSecretEnvDelivered && Object.keys(args.scopedEnv ?? {}).length
        ? {
            onBridgeStarted: async () => { args.onSecretEnvDelivered?.(); },
          }
        : {}),
      targetKind: "local-native",
      bridgePort,
      scopedEnv: {
        ...(args.scopedEnv ?? {}),
        ...(args.scope === "unattended" ? { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooksPath, GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "" } : {}),
      },
    });

    // Built before the teardown that has to drop it, so the drop can prove the
    // entry under this id is still the one this turn registered.
    let leaseBearer = args.bearer;
    const sessionRecord: LocalHarnessSessionRecord = {
      userId: args.target.actingUserId,
      projectId: args.projectId,
      sessionId: args.sessionId,
      runtimeId: plan.runtime.runtimeId,
      workspaceGrantId: plan.target.workspaceGrantId,
      brokerRunId: broker.runId,
      gateway: started,
      stop: async () => await supervisor.stopSession(args.sessionId),
      revokeLease: () => revokeLease(currentRunId, leaseBearer),
      releaseRuntime: outer.releaseRuntimeUse,
      // A Stop, stop-all, workspace or project stop ends a parked session
      // through this registry; the parked record must stop answering at once.
      onEnded: () => noteParkedLocalSessionEnded(args.sessionId),
      startedAt: Date.now(),
    };

    let treeStopped = false;
    const teardownOnce = onceAsync(async () => {
      try {
        started.revoke();
        await started.close();
      } finally {
        await revokeLease(currentRunId, leaseBearer);
        // Stop the supervised tree, THEN give up the reservation. This is the
        // teardown a normal turn takes — `run-harness-turn.ts` calls it when
        // the model stream ends — and `endLocalHarnessSession` never reaches
        // it, so nothing else was going to stop the tree on this path. The
        // reservation is what stops another process replacing the directory
        // these children execute from, so releasing it while they are still
        // alive is the one ordering that must not happen.
        //
        // And only when the stop SUCCEEDED. `stopSession` answers
        // `{ stopped, escaped }`, and a `finally` that released regardless
        // handed the directory back while escaped children were still
        // executing from it — `activateVerifiedPack` would then be free to
        // replace it. A tree that cannot be proven down keeps its claim; the
        // reservation outliving a leak is the safe direction.
        const stop = await supervisor.stopSession(args.sessionId);
        // Dropped from the registry only in here, and only on a proven stop.
        //
        // Dropping it FIRST — which is what this did — was right for the normal
        // case and wrong for the one the check above exists for: it deleted the
        // record, then declined to release, leaving an escaped tree holding the
        // reservation with nothing left in this process that could stop it or
        // hand it back. `stop-all` reads this map, so the retry path went out
        // with the record. Keeping it registered is also the honest count: that
        // session really is still running.
        //
        // On the normal path this still drops the record, which is the reason
        // it is here at all — a completed turn that left one behind would add a
        // dead session to `stop-all` and to the telemetry count every time.
        //
        // And by RECORD, not by id: this runs after a SIGTERM grace now, and by
        // id alone a late teardown would remove whatever is registered under
        // that id at the time — a live session from a later turn included.
        if (stop.stopped) {
          treeStopped = true;
          forgetLocalHarnessSessionRecord(sessionRecord);
          await outer.releaseRuntimeUse();
        }
      }
    });

    // Registered so `stop-all` and the abort path can end this session without
    // holding a reference to the turn that created it.
    registerLocalHarnessSession(sessionRecord);

    logger.info("[local-harness] turn prepared", {
      sessionId: args.sessionId,
      runtimeId: plan.runtime.runtimeId,
      permissionMode,
      localRuntimeVerifyMs,
      localGatewayReadyMs,
    });

    const live: LiveLocalRuntime = {
      prepared: undefined as unknown as PreparedLocalHarnessTurn,
      userId: args.target.actingUserId,
      projectId: args.projectId,
      runtimeId: plan.runtime.runtimeId,
      workspaceGrantId: plan.target.workspaceGrantId,
      rebindLease: (next) => {
        // Throws (and leaves the gateway held) for an unusable lease.
        started.rebind(next.lease);
        currentRunId = next.runId;
        leaseBearer = next.bearer;
        sessionRecord.brokerRunId = next.runId;
      },
      revokeCurrentLease: () => revokeLease(currentRunId, leaseBearer),
    };
    const prepared: PreparedLocalHarnessTurn = {
      plan,
      sandbox,
      auth: localChildAuth(harnessId, started),
      sandboxWorkDir: "project",
      skillsBaseDir: toAdapterPath(
        join(sessionStateDir, "home", ...LOCAL_SKILLS_SUBDIR[harnessId]),
      ),
      sessionStateExists,
      permissionMode,
      brokerRunId: broker.runId,
      timings: { localRuntimeVerifyMs, localGatewayReadyMs },
      teardown: teardownOnce,
      discardState: onceAsync(async () => {
        await teardownOnce();
        if (treeStopped) await removeSessionStateDir(sessionStateDir);
      }),
      park: (parkArgs) =>
        parkLocalSession<LiveLocalRuntime>({
          sessionId: args.sessionId,
          generation: parkArgs.generation,
          userId: args.target.actingUserId,
          projectId: args.projectId,
          pendingApprovalIds: parkArgs.pendingApprovalIds,
          resources: live,
          ...(parkArgs.ttlMs !== undefined ? { ttlMs: parkArgs.ttlMs } : {}),
          // ONE owner for cleanup: the registry, which revokes the gateway and
          // the lease, stops the tree and releases the runtime together.
          end: async (reason: ParkInvalidationReason) => {
            logger.info("[local-harness] ending parked session", {
              sessionId: args.sessionId,
              reason,
            });
            await endLocalHarnessSession(args.sessionId);
          },
          isAlive: () => supervisor.liveProcessCount(args.sessionId) > 0,
          holdModelTraffic: () => {
            // Nothing is generated while nobody is deciding anything, and the
            // lease is not kept live across a human wait: a fresh one is
            // minted, after re-checking authorization, when a decision lands.
            started.hold();
            void revokeLease(currentRunId, leaseBearer);
          },
        }),
      unpark: () => releaseParkedLocalSession(args.sessionId),
    };
    live.prepared = prepared;
    return { ok: true, prepared };
  } catch (error) {
    // Whatever went wrong, the lease and any listener that could spend it go
    // with it. Both steps are attempted; a gateway that will not close is not a
    // reason to leave the lease live.
    await abandonLocalSetup({
      gateway,
      sessionId: args.sessionId,
      runId: broker.runId,
      bearer: args.bearer,
    });
    throw error;
  }
}

/** A live local runtime, as a parked approval holds it. */
interface LiveLocalRuntime {
  prepared: PreparedLocalHarnessTurn;
  userId: string;
  projectId: string;
  runtimeId: string;
  workspaceGrantId: string;
  /** Bind a fresh lease to the SAME gateway (same port, same capability). */
  rebindLease: (next: { runId: string; lease: string; bearer: string }) => void;
  revokeCurrentLease: () => Promise<void>;
}

/**
 * Hand a runtime parked on an approval to the turn delivering the decision.
 *
 * The claim is synchronous and exactly-once (`approval-park.ts`). Everything
 * after it re-establishes AUTHORITY rather than assuming it survived the wait:
 * the availability gate runs again (kill switch, actor, consent, workspace,
 * runtime identity), and the model lease — revoked at the pause — is replaced
 * by a fresh one bound to the gateway the process already knows. Any failure
 * there ends the parked session: a decision that cannot be delivered under
 * current authority is not delivered at all.
 */
async function adoptParkedLocalTurn(
  args: PrepareLocalHarnessTurnArgs,
  harnessId: SupportedLocalHarnessId,
): Promise<LocalHarnessTurnPreparation> {
  const continuation = args.approvalContinuation!;
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
  const live = claim.parked.resources;
  const fail = async (
    reason: ParkInvalidationReason,
    status: string,
    message: string,
  ): Promise<LocalHarnessTurnPreparation> => {
    await invalidateParkedLocalSession(args.sessionId, reason);
    return { ok: false, status, message };
  };
  const verifyStartedAt = Date.now();

  const runtimeStatus = await readRuntimeInstallStatus({ harnessId });
  if (runtimeStatus.state !== "ready") {
    return fail(
      "authorization-revoked",
      "runtime-unavailable",
      "The local runtime holding this approval is no longer installed; the " +
        "pending action will not run.",
    );
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
    installedAdapterVersion:
      args.installedAdapterVersion ??
      (await readInstalledAdapterVersion(harnessId)),
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
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!broker.ok) {
    return fail("renewal-failed", "broker-unavailable", broker.error);
  }
  // The awaits above are a window in which the parked tree can die or a Stop
  // can land. Re-check before binding the fresh lease: delivering the decision
  // to a bridge that had to be respawned could approve an action nobody saw.
  if (claim.parked.state !== "continuing" || !claim.parked.isAlive()) {
    await revokeLease(broker.runId, args.bearer);
    return fail(
      "process-died",
      "approval-process-died",
      "The local runtime holding this approval stopped while the decision " +
        "was being delivered; the pending action will not run.",
    );
  }
  try {
    live.rebindLease({ runId: broker.runId, lease: broker.lease, bearer: args.bearer });
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
  logger.info("[local-harness] parked session re-adopted for an approval", {
    sessionId: args.sessionId,
    approvals: continuation.approvalIds.length,
  });
  return {
    ok: true,
    prepared: {
      ...live.prepared,
      plan,
      sessionStateExists: true,
      brokerRunId: broker.runId,
      timings: {
        localRuntimeVerifyMs: gatewayStartedAt - verifyStartedAt,
        localGatewayReadyMs: Date.now() - gatewayStartedAt,
      },
    },
  };
}

/**
 * Undo a local setup that failed partway through.
 *
 * Not `endLocalHarnessSession`: there is no supervised tree yet, and there may
 * be no registry record either — the failure can land before registration. What
 * there always is, past the broker, is a lease; and there may be a listener
 * holding it.
 */
async function abandonLocalSetup(args: {
  gateway: LocalModelGateway | null;
  sessionId: string;
  runId: string;
  bearer: string;
}): Promise<void> {
  try {
    args.gateway?.revoke();
    await args.gateway?.close();
  } catch (error) {
    logger.warn("[local-harness] gateway close during abandoned setup failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  // A no-op unless the failure landed after registration, which is the one
  // window where a record exists for a session that will never run.
  forgetLocalHarnessSession(args.sessionId);
  await revokeLease(args.runId, args.bearer);
}

async function revokeLease(runId: string, bearer: string): Promise<void> {
  try {
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

/**
 * The version of the adapter package actually installed next to this server.
 *
 * The manifest pins an exact version, and the compatibility gate refuses a
 * mismatch — so the value has to come from the installed package rather than
 * from the manifest, or the check would be comparing the pin to itself.
 */
declare const __MCPJAM_CLAUDE_ADAPTER_VERSION__: string | undefined;
let cachedAdapterVersion: string | null = null;

async function readInstalledAdapterVersion(
  harnessId: SupportedLocalHarnessId,
): Promise<string> {
  // Codex's local adapter is MCPJam's own bridge bundle plus the pinned CLI,
  // compiled into this server (npx and Electron alike): there is no npm
  // package to read a version from. See `codex-appserver/local-identity.ts`.
  if (harnessId === "codex") return CODEX_LOCAL_ADAPTER_IDENTITY;
  if (cachedAdapterVersion !== null) return cachedAdapterVersion;
  if (typeof __MCPJAM_CLAUDE_ADAPTER_VERSION__ === "string") return __MCPJAM_CLAUDE_ADAPTER_VERSION__;
  try {
    const required = createRequire(import.meta.url);
    const pkg = required("@ai-sdk/harness-claude-code/package.json") as {
      version?: unknown;
    };
    cachedAdapterVersion = typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    // An adapter we cannot identify fails the compatibility gate's exact-pin
    // check, which is the correct outcome: a runtime whose adapter version is
    // unknown is not one the manifest can vouch for.
    cachedAdapterVersion = "";
  }
  return cachedAdapterVersion;
}

/** Run an async function at most once, whatever the caller does. */
function onceAsync(fn: () => Promise<void>): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    started ??= fn();
    return started;
  };
}
