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
import { startLocalModelGateway } from "./model-gateway.js";
import { readRuntimeInstallStatus } from "./runtime-install.js";
import { createSupervisedLocalHarnessProvider } from "./supervised-provider.js";
import { LocalHarnessSupervisor } from "./supervisor.js";
import { localHarnessStateRoot } from "./grants.js";
import {
  getRegisteredKeyId,
  readLocalInstanceIdentity,
} from "./instance-key.js";
import {
  forgetLocalHarnessSession,
  registerLocalHarnessSession,
} from "./session-registry.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
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
  permissionMode: "allow-reads" | "allow-edits" | "allow-all";
  brokerRunId: string;
  /** Fields for the turn's timing telemetry. Durations, never paths. */
  timings: {
    localRuntimeVerifyMs: number;
    localGatewayReadyMs: number;
  };
  /** Idempotent. Revokes the gateway, revokes the lease, stops the tree. */
  teardown: () => Promise<void>;
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

/** A free loopback port for the session's bridge. */
async function reserveLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not reserve a bridge port")));
        return;
      }
      const { port } = address;
      // Closed before the bridge binds it. The window between is narrowed
      // further by `assertBridgePortUnclaimed`, which runs immediately before
      // the spawn and refuses a port something else has taken.
      probe.close(() => resolvePromise(port));
    });
  });
}

export interface PrepareLocalHarnessTurnArgs {
  target: LocalHarnessExecutionTarget;
  harnessId: HarnessId;
  modelId: string;
  sessionId: string;
  runId: string;
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
  /** Set when the host asks for tool approval, which narrows the mode. */
  requireToolApproval?: boolean;
  /** Env the adapter needs beyond the model credential (bridge token, port). */
  scopedEnv?: Readonly<Record<string, string>>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export async function prepareLocalHarnessTurn(
  args: PrepareLocalHarnessTurnArgs,
): Promise<LocalHarnessTurnPreparation> {
  const verifyStartedAt = Date.now();

  // The pack's install root is where availability looks for a runtime. Reading
  // it from the installer rather than a constant means the Electron override
  // and the npx default cannot disagree.
  const runtimeStatus = await readRuntimeInstallStatus({
    harnessId: "claude-code",
  });
  if (runtimeStatus.state !== "ready") {
    return {
      ok: false,
      status: "runtime-unavailable",
      message:
        runtimeStatus.state === "absent"
          ? "The local Claude Code runtime is not installed on this machine yet."
          : `The local Claude Code runtime is not usable (${runtimeStatus.state}).`,
    };
  }

  const availability = await resolveLocalHarnessAvailability({
    target: {
      kind: "local-native",
      harnessId: args.harnessId as "claude-code" | "codex",
      machineId: args.target.machineId,
      workspaceGrantId: args.target.workspaceGrantId,
      runtimeId: args.target.runtimeId,
      permissionProfile: args.target.permissionProfile,
      policyVersion: args.target.policyVersion,
    },
    actor: args.actor,
    // Server-derived, never from a request body: consent binds to a user, and
    // a user the caller names is a user the caller chose.
    userId: args.target.actingUserId,
    projectId: args.projectId,
    grantToken: args.target.grantToken,
    runtimeRoot: runtimeStatus.runtimeRoot,
    installedAdapterVersion:
      args.installedAdapterVersion ?? (await readInstalledAdapterVersion()),
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

  // A host that asks for tool approval narrows the mode: `allow-reads` is the
  // only mode under which MCP tools pause, which is what approval means.
  const permissionMode = args.requireToolApproval
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
    return {
      ok: false,
      status: "broker-unavailable",
      message: broker.error,
    };
  }

  const supervisor = localHarnessSupervisor();
  const sessionStateDir = join(
    localHarnessStateRoot(),
    "sessions",
    args.sessionId,
  );
  await mkdir(sessionStateDir, { recursive: true, mode: 0o700 });

  const gatewayStartedAt = Date.now();
  let gateway: Awaited<ReturnType<typeof startLocalModelGateway>>;
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
  const localGatewayReadyMs = Date.now() - gatewayStartedAt;

  const bridgePort = await reserveLoopbackPort();
  const launcher = resolveNodeLauncher({
    // Inside the tree the digest just covered. The npx server's own execPath is
    // not, and Electron cannot be a launcher at all.
    bundledNodePath: plan.runtime.nodePath ?? "",
  });

  const sandbox = createSupervisedLocalHarnessProvider({
    harnessId: "claude-code",
    manifest: plan.manifest,
    runtime: plan.runtime,
    supervisor,
    launcher,
    workspacePath: plan.workspacePath,
    workspaceGrantId: plan.target.workspaceGrantId,
    sessionStateDir,
    targetKind: "local-native",
    bridgePort,
    scopedEnv: {
      ...(args.scopedEnv ?? {}),
    },
  });

  const teardownOnce = onceAsync(async () => {
    try {
      gateway.revoke();
      await gateway.close();
    } finally {
      // Dropped from the registry here, not only on the stop-all path: a turn
      // that ends normally leaves a record behind otherwise, and the map is
      // what `stop-all` and the telemetry count read. Every completed local
      // turn would add one more dead session to both.
      forgetLocalHarnessSession(args.sessionId);
      await revokeLease(broker.runId, args.bearer);
    }
  });

  // Registered so `stop-all` and the abort path can end this session without
  // holding a reference to the turn that created it.
  registerLocalHarnessSession({
    sessionId: args.sessionId,
    runtimeId: plan.runtime.runtimeId,
    workspaceGrantId: plan.target.workspaceGrantId,
    brokerRunId: broker.runId,
    gateway,
    stop: async () => {
      await supervisor.stopSession(args.sessionId);
    },
    revokeLease: () => revokeLease(broker.runId, args.bearer),
    startedAt: Date.now(),
  });

  logger.info("[local-harness] turn prepared", {
    sessionId: args.sessionId,
    runtimeId: plan.runtime.runtimeId,
    permissionMode,
    localRuntimeVerifyMs,
    localGatewayReadyMs,
  });

  return {
    ok: true,
    prepared: {
      plan,
      sandbox,
      // The child's credential: the gateway, and a capability that means
      // nothing anywhere else. The lease is not in here and never will be.
      auth: {
        ANTHROPIC_AUTH_TOKEN: gateway.sessionCapability,
        ANTHROPIC_API_KEY: gateway.sessionCapability,
        ANTHROPIC_BASE_URL: gateway.baseUrl,
      } as HarnessAuth,
      sandboxWorkDir: "project",
      permissionMode,
      brokerRunId: broker.runId,
      timings: { localRuntimeVerifyMs, localGatewayReadyMs },
      teardown: teardownOnce,
    },
  };
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
let cachedAdapterVersion: string | null = null;

async function readInstalledAdapterVersion(): Promise<string> {
  if (cachedAdapterVersion !== null) return cachedAdapterVersion;
  try {
    const required = createRequire(import.meta.url);
    const pkg = required("@ai-sdk/harness-claude-code/package.json") as {
      version?: unknown;
    };
    cachedAdapterVersion =
      typeof pkg.version === "string" ? pkg.version : "";
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
