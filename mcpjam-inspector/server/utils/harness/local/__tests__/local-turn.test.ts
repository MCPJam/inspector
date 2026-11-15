import { readLocalHarnessAuthorization } from "../authorization.js";
import { HARNESS_SKILLS } from "../../skills-descriptor.js";
vi.mock("../authorization.js", () => ({ readLocalHarnessAuthorization: vi.fn(async () => ({ autoApproveAcknowledgedAt: "2026-10-04T00:00:00.000Z" })) }));
import { toAdapterPath } from "../adapter-path.js";
import { MCPClientManager } from "@mcpjam/sdk";
import { resetLocalHarnessRegistryForTests } from "../session-registry.js";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessTurnEventProperties } from "@/shared/harness-turn-event";
import { HarnessTurnRecord } from "../../harness-turn-event.js";
import { TurnTiming } from "../../../turn-timing.js";

// Everything a local turn reaches for, stubbed at the module boundary. The
// subject here is the ORDER these are torn down in when one of them fails —
// not what any of them does.
const revokeHarnessModelBroker = vi.fn(async () => undefined);
const startLoopbackModelBroker = vi.fn(async () => ({
  ok: true as const,
  runId: "run_1",
  expiresAt: Date.now() + 60_000,
  protocol: "anthropic" as const,
  proxyBaseUrl: "https://api.example.test/proxy",
  delivery: "inspector-loopback-gateway" as const,
  lease: "lease.token.value",
}));
const gatewayRevoke = vi.fn();
const gatewayClose = vi.fn(async () => undefined);
const gatewayHold = vi.fn();
const gatewayRebind = vi.fn();
const startLocalModelGateway = vi.fn(async () => ({
  baseUrl: "http://127.0.0.1:1",
  port: 1,
  sessionCapability: "cap",
  revoke: gatewayRevoke,
  close: gatewayClose,
  hold: gatewayHold,
  rebind: gatewayRebind,
  stats: () => ({ requests: 0, rejected: 0, forwarded: 0, upstreamErrors: 0 }),
}));
const resolveNodeLauncher = vi.fn(() => ({ command: "node", args: [] }));
const createSupervisedLocalHarnessProvider = vi.fn(() => ({ forbidNewProcesses: vi.fn() }) as never);

let stateRoot = "";

vi.mock("../../harness-model-broker.js", () => ({
  revokeHarnessModelBroker: (...a: unknown[]) =>
    revokeHarnessModelBroker(...(a as [])),
  startLoopbackModelBroker: (...a: unknown[]) =>
    startLoopbackModelBroker(...(a as [])),
}));
vi.mock("../model-gateway.js", () => ({
  startLocalModelGateway: (...a: unknown[]) =>
    startLocalModelGateway(...(a as [])),
}));
vi.mock("../node-launcher.js", () => ({
  resolveNodeLauncher: (...a: unknown[]) => resolveNodeLauncher(...(a as [])),
}));
vi.mock("../supervised-provider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../supervised-provider.js")>(),
  createSupervisedLocalHarnessProvider: (...a: unknown[]) =>
    createSupervisedLocalHarnessProvider(...(a as [])),
}));
const readRuntimeInstallStatus = vi.hoisted(() => vi.fn(async () => ({
  state: "ready" as const,
  // A pack version and digest as well, because the turn now takes a runtime
  // USE reservation keyed on the pack identity before it verifies anything —
  // that reservation is what stops another Inspector replacing the tree these
  // children execute from.
  packVersion: "test-pack-1",
  digest: `sha256:${"a".repeat(64)}`,
  // The RUNTIME root stays unreachable: these tests are about what happens
  // when a later step fails, and the bundle never has to resolve.
  runtimeRoot: "/nonexistent/runtime-root",
})));
vi.mock("../runtime-install.js", () => ({
  readRuntimeInstallStatus: () => readRuntimeInstallStatus(),
  isTerminalInstallStatus: (status: { state: string }) =>
    status.state !== "downloading" && status.state !== "verifying",
  // The INSTALL root must be writable, though — the reservation is a real file
  // in a real directory. Pointing it at `/nonexistent` made every test in this
  // file fail with EACCES on any machine that is not root, which is what CI
  // caught and a root-owned sandbox did not.
  runtimeInstallRoot: () => installRoot,
  noteRuntimeLaunch: vi.fn(async () => {}),
}));
// Mutable so a test can drive the `keyId === null` refusal — an Inspector
// whose local installation is not registered yet.
const identityFixture = vi.hoisted(() => ({ keyId: "key_1" as string | null }));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({
    machineId: "machine_1",
    publicKey: "pub",
    keyId: identityFixture.keyId,
  }),
  getRegisteredKeyId: () => identityFixture.keyId,
}));
const resolveLocalHarnessAvailability = vi.hoisted(() => vi.fn(async (_query: Record<string, unknown>) => ({
    available: true,
    plan: {
      target: {
        kind: "local-native",
        harnessId: "claude-code",
        machineId: "machine_1",
        workspaceGrantId: "ws_1",
        runtimeId: "rt_1",
        permissionProfile: "workspace-edits",
        policyVersion: "v1",
      },
      manifest: {},
      runtime: { runtimeId: "rt_1", nodePath: "/nonexistent/node" },
      workspacePath: "/nonexistent/workspace",
      permissionMode: "allow-edits",
      grantId: "grant_1",
    },
  })));
vi.mock("../availability.js", () => ({
  resolveLocalHarnessAvailability: (query: Record<string, unknown>) =>
    resolveLocalHarnessAvailability(query),
}));
// The pack re-verification, controllable: an adoption re-verifies the parked
// process's own pack, and a test changes that pack's answer.
const revalidateRuntime = vi.hoisted(() => vi.fn(async (_runtime: unknown) => ({ ok: true as boolean, message: "" })));
vi.mock("../runtime-identity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../runtime-identity.js")>(),
  revalidateRuntime: (runtime: unknown) => revalidateRuntime(runtime),
}));
vi.mock("../grants.js", () => ({
  localHarnessStateRoot: () => stateRoot,
}));
// The supervisor, only so a test can make `stopSession` report an ESCAPED
// tree. The default is the answer the real one gives for a session that never
// spawned anything, so every other test in this file behaves as before.
const supervisorFixture = vi.hoisted(() => ({
  stopOutcome: { stopped: true } as { stopped: boolean; escaped?: number },
  stopCalls: 0,
  live: 1,
  wallClockRestarts: [] as string[],
}));
vi.mock("../supervisor.js", () => ({
  LocalHarnessSupervisor: class {
    ownsPid() {
      return false;
    }
    async stopSession() {
      supervisorFixture.stopCalls += 1;
      return supervisorFixture.stopOutcome;
    }
    liveProcessCount() {
      return supervisorFixture.live;
    }
    restartWallClock(sessionId: string) {
      supervisorFixture.wallClockRestarts.push(sessionId);
    }
  },
}));

const { prepareLocalHarnessTurn } = await import("../local-turn.js");
const { noteTurnRuntimeStatus } = await import("../turn-runtime-status.js");
const {
  resetApprovalParkForTests,
  describeParkedLocalSession,
  endParkIfWaiting,
  parkLocalTurn,
  shutdownLocalTurnParks,
  DEFAULT_TURN_PARK_TTL_MS,
  KEPT_END_RETENTION_MS,
  MAX_TURN_PARKS,
  TURN_PARK_LIFETIME_MS,
} = await import("../approval-park.js");
// Real, not mocked: whether a reservation is still held is the subject here.
const { runtimeUseState } = await import("../runtime-lifecycle.js");
const { localPackTarget } = await import("../targets.js");
const {
  endLocalHarnessSession,
  forgetLocalHarnessSession,
  getLocalHarnessSession,
  listLocalHarnessSessions,
  registerLocalHarnessSession,
} = await import("../session-registry.js");

function turnArgs() {
  return {
    sessionId: "s_local_1",
    harnessId: "claude-code" as const,
    modelId: "claude-haiku",
    projectId: "proj_1",
    bearer: "bearer",
    requireToolApproval: false,
    target: {
      machineId: "machine_1",
      workspaceGrantId: "ws_1",
      runtimeId: "rt_1",
      permissionProfile: "workspace-edits" as const,
      policyVersion: "v1",
      actingUserId: "user_1",
      grantToken: "grant-token",
    },
    actor: { kind: "member" },
  } as unknown as Parameters<typeof prepareLocalHarnessTurn>[0];
}

let tempDir = "";
/** Writable install root for the turn's runtime-use reservation. */
let installRoot = "";

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-turn-")));
  stateRoot = tempDir;
  installRoot = join(tempDir, "runtime");
  identityFixture.keyId = "key_1";
  supervisorFixture.stopOutcome = { stopped: true };
  supervisorFixture.stopCalls = 0;
  supervisorFixture.live = 1;
  supervisorFixture.wallClockRestarts = [];
  // `reset`, not `clear`: a `…Once` override that a failing test never consumed
  // would otherwise leak into the next one. Vitest 3's reset restores the
  // implementation each spy was created with, which is the base behaviour here.
  vi.resetAllMocks();
  resetLocalHarnessRegistryForTests();
  resetApprovalParkForTests();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("a local setup that fails partway through", () => {
  it("revokes the lease and closes the gateway when a later step throws", async () => {
    // The lease exists from the broker call onward, and the gateway is a
    // loopback listener that can spend it. A throw between the two and the
    // session being registered used to leave BOTH behind — unreachable by
    // `stop-all`, which reads the registry, and untouched by any teardown,
    // because the turn never got one. Only the lease's TTL would have ended it.
    resolveNodeLauncher.mockImplementationOnce(() => {
      throw new Error("no usable node in the pack");
    });

    await expect(prepareLocalHarnessTurn(turnArgs())).rejects.toThrow(
      "no usable node in the pack",
    );

    expect(gatewayRevoke).toHaveBeenCalledTimes(1);
    expect(gatewayClose).toHaveBeenCalledTimes(1);
    expect(revokeHarnessModelBroker).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_1" }),
    );
    expect(listLocalHarnessSessions()).toEqual([]);
  });

  it("still revokes the lease when the gateway itself will not close", async () => {
    // Every step is attempted. A gateway that will not close is not a reason to
    // leave a live credential on the backend.
    gatewayClose.mockRejectedValueOnce(new Error("socket wedged"));
    createSupervisedLocalHarnessProvider.mockImplementationOnce(() => {
      throw new Error("provider refused");
    });

    await expect(prepareLocalHarnessTurn(turnArgs())).rejects.toThrow(
      "provider refused",
    );
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
  });

  it("revokes the lease when the session state directory cannot be created", async () => {
    // The earliest window: a lease and nothing else. The gateway has not
    // started, so there is nothing to close — and the lease still goes.
    // A regular FILE where the state root should be: `mkdir -p` under it is
    // ENOTDIR, deterministically, on every platform.
    const blocked = join(stateRoot, "not-a-directory");
    await writeFile(`${blocked}-sessions`, "");
    stateRoot = blocked;
    await expect(prepareLocalHarnessTurn(turnArgs())).rejects.toThrow();
    expect(startLocalModelGateway).not.toHaveBeenCalled();
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
  });

  it("revokes the lease when the gateway refuses to start, without throwing", async () => {
    // This one is a REFUSAL, not a crash: the caller gets a status it can show.
    startLocalModelGateway.mockRejectedValueOnce(
      new Error("upstream must be https"),
    );
    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result).toMatchObject({ ok: false, status: "gateway-unavailable" });
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
  });
});

describe("a local turn on the organization's own key", () => {
  const selection = {
    source: "org" as const,
    modelId: "anthropic/claude-haiku-4.5",
    connectionRef: { kind: "orgProvider" as const, id: "conn_1" },
  };

  it("carries the org selection to the loopback start and surfaces the confirmed binding", async () => {
    const orgUpstream = {
      credentialSource: "org" as const,
      profile: "anthropic-native" as const,
      nativeModelId: "claude-haiku-4-5",
      credentialRevision: "0123456789abcdef",
    };
    startLoopbackModelBroker.mockImplementationOnce(async () => ({
      ok: true as const,
      runId: "run_1",
      expiresAt: Date.now() + 60_000,
      protocol: "anthropic" as const,
      proxyBaseUrl: "https://api.example.test/proxy",
      delivery: "inspector-loopback-gateway" as const,
      lease: "lease.token.value",
      orgUpstream,
    }));
    const result = await prepareLocalHarnessTurn({
      ...turnArgs(),
      modelSelection: selection as never,
    });
    expect(startLoopbackModelBroker).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelSelection: selection }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.orgUpstream).toEqual(orgUpstream);
    // Still a capability, never the lease, on the org key too.
    expect(JSON.stringify(result.prepared.auth)).not.toContain("lease.token");
    await result.prepared.teardown();
  });

  it("a hosted turn's loopback start carries no selection", async () => {
    const result = await prepareLocalHarnessTurn(turnArgs());
    const startArgs = (
      startLoopbackModelBroker.mock.lastCall as unknown[]
    )?.[0] as Record<string, unknown> | undefined;
    expect(startArgs && "modelSelection" in startArgs).toBe(false);
    if (result.ok) {
      expect(result.prepared.orgUpstream).toBeUndefined();
      await result.prepared.teardown();
    }
  });
});

describe("a local setup that succeeds", () => {
  it("owns the MCP listener through pause, rebind, and stop-all cleanup", async () => {
    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manager = new MCPClientManager({});
    const plane = await result.prepared.bindMcpPlane({ manager, serverIds: [], turnId: "first" });
    const strategy = { ...plane.strategy };
    expect(result.prepared.park({ generation: "generation", pendingApprovalIds: ["approval"] })).not.toBeNull();
    const request = () => fetch(`${strategy.baseUrl}/selected`, {
      method: "POST", headers: { "x-mcpjam-proxy-token": strategy.token },
    });
    expect((await request()).status).toBe(403);
    const rebound = await result.prepared.bindMcpPlane({ manager, serverIds: [], turnId: "next" });
    expect(rebound.strategy).toEqual(strategy);
    expect((await request()).status).toBe(404);
    await endLocalHarnessSession(turnArgs().sessionId);
    await expect(request()).rejects.toThrow();
  });

  it("registers the session and hands back a capability, never the lease", async () => {
    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.prepared.auth)).not.toContain("lease.token");
    expect(result.prepared.auth.ANTHROPIC_API_KEY).toBe("cap");
    expect(getLocalHarnessSession("s_local_1")).toBeDefined();
    expect(revokeHarnessModelBroker).not.toHaveBeenCalled();

    // …and the turn's own teardown ends it, rather than leaving a dead record
    // for `stop-all` and the telemetry count to read.
    await result.prepared.teardown();
    expect(gatewayRevoke).toHaveBeenCalledTimes(1);
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
    expect(getLocalHarnessSession("s_local_1")).toBeUndefined();
  });

  it("keeps a session whose tree escaped, so stop-all can try again", async () => {
    // The turn's teardown declines to release the reservation when the stop
    // cannot prove the tree is down — but it used to drop the registry record
    // FIRST, unconditionally. That left an escaped tree holding the version
    // directory with nothing in this process able to stop it or hand it back:
    // `stop-all` reads this map, so the retry went out with the record and
    // reinstall and repair stayed blocked until the Inspector quit.
    supervisorFixture.stopOutcome = { stopped: false, escaped: 2 };
    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.prepared.teardown();
    expect(supervisorFixture.stopCalls).toBe(1);
    // Still listed, and still holding its claim on the runtime directory.
    expect(getLocalHarnessSession("s_local_1")).toBeDefined();
    await expect(
      runtimeUseState({
        key: {
          runtimeRoot: installRoot,
          harnessId: "claude-code",
          target: localPackTarget()!,
          packVersion: "test-pack-1",
          treeDigest: `sha256:${"a".repeat(64)}`,
        },
        runtimeRoot: "/nonexistent/runtime-root",
      }),
    ).resolves.toMatchObject({ busy: true });

    // And the retained record is what lets a later stop finish the job.
    supervisorFixture.stopOutcome = { stopped: true };
    await endLocalHarnessSession("s_local_1");
    expect(getLocalHarnessSession("s_local_1")).toBeUndefined();
    await expect(
      runtimeUseState({
        key: {
          runtimeRoot: installRoot,
          harnessId: "claude-code",
          target: localPackTarget()!,
          packVersion: "test-pack-1",
          treeDigest: `sha256:${"a".repeat(64)}`,
        },
        runtimeRoot: "/nonexistent/runtime-root",
      }),
    ).resolves.toMatchObject({ busy: false });
  });
});

describe("a teardown that finishes late", () => {
  it("drops only its OWN record, never a session registered since", async () => {
    // Dropping the record moved AFTER the stop, so it now runs on the far side
    // of a SIGTERM grace. By session id alone it would remove whatever is
    // registered under that id by then — including a live session from a later
    // turn, putting a running tree beyond the reach of `stop-all`. The id is
    // a fresh uuid per turn today, so this is unreachable through
    // `run-harness-turn.ts`; the comparison is what stops that invariant, which
    // lives in another file, from being load-bearing here.
    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // A later turn claims the same id while this one is still tearing down.
    const later = {
      ...(getLocalHarnessSession("s_local_1") as NonNullable<
        ReturnType<typeof getLocalHarnessSession>
      >),
      runtimeId: "rt_later",
    };
    registerLocalHarnessSession(later);

    await result.prepared.teardown();
    // Still reachable, and still the LATER record.
    expect(getLocalHarnessSession("s_local_1")?.runtimeId).toBe("rt_later");
    forgetLocalHarnessSession("s_local_1");
  });
});

describe("a refused turn does not keep the runtime reserved", () => {
  it("releases the reservation when preparation refuses", async () => {
    // A refusal is a RESOLVED value, not a throw, so it never reached the
    // caller's `catch` — and the reservation it left behind names this live
    // server process, so nothing reclaims it. `activateVerifiedPack` then
    // refuses to replace a version directory "in use by N running session(s)",
    // counting sessions that never started: one declined turn disabled
    // reinstall and repair for the rest of the process's life.
    identityFixture.keyId = null;

    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result).toMatchObject({ ok: false, status: "consent-required" });

    await expect(
      runtimeUseState({
        key: {
          runtimeRoot: installRoot,
          harnessId: "claude-code",
          target: localPackTarget()!,
          packVersion: "test-pack-1",
          treeDigest: `sha256:${"a".repeat(64)}`,
        },
        runtimeRoot: "/nonexistent/runtime-root",
      }),
    ).resolves.toMatchObject({ busy: false });
  });
});

describe("a runtime this Inspector cannot reserve", () => {
  it("refuses the turn instead of throwing out of preparation", async () => {
    // The reservation is what stops another Inspector — or the install CLI —
    // replacing the tree this session's children are about to execute from.
    // A machine where it cannot be taken (a read-only runtime root, a full
    // disk, the wrong owner) must not run the session unprotected, and must
    // not surface the failure as an unhandled ENOSPC/EACCES either: CI caught
    // exactly that, with every test in this file dying on `mkdir` before it
    // reached its own subject.
    // A FILE where the reservation needs a directory, so `mkdir` fails with
    // ENOTDIR for every user. Deliberately not a `chmod`: this suite runs as
    // root in some containers, where a permission bit stops nothing — which is
    // precisely how the original defect survived a green local run.
    await writeFile(join(tempDir, "not-a-directory"), "");
    installRoot = join(tempDir, "not-a-directory", "runtime");

    const result = await prepareLocalHarnessTurn(turnArgs());
    expect(result).toMatchObject({ ok: false, status: "runtime-unavailable" });
    expect((result as { message: string }).message).toMatch(
      /could not reserve/,
    );
    // And nothing was started that would then need tearing down.
    expect(startLoopbackModelBroker).not.toHaveBeenCalled();
  });
});


describe("local lane state lifetime", () => {
  it("refuses unsafe secret names before starting a model lease", async () => {
    await expect(prepareLocalHarnessTurn({ ...turnArgs(), scopedEnv: { HOME: "/elsewhere" } }))
      .rejects.toThrow("not allowed");
    expect(startLoopbackModelBroker).not.toHaveBeenCalled();
  });

  it.each(["ANTHROPIC_API_KEY", "anthropic_auth_token", "BRIDGE_WS_PORT", "CLAUDE_CODE_SETTINGS_FILE"])(
    "refuses project secrets overriding runtime-owned %s", async (name) => {
      await expect(prepareLocalHarnessTurn({ ...turnArgs(), scopedEnv: { [name]: "test" } }))
        .rejects.toThrow("conflicts");
      expect(startLoopbackModelBroker).not.toHaveBeenCalled();
    },
  );

  it("delivers scoped secrets and reports delivery only after bridge startup", async () => {
    const delivered = vi.fn();
    const result = await prepareLocalHarnessTurn({
      ...turnArgs(), scopedEnv: { SERVICE_KEY: "test-value" }, onSecretEnvDelivered: delivered,
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.prepared.homeDir).toBe(toAdapterPath(join(`${stateRoot}-sessions`, turnArgs().sessionId, "home")));
    const providerArgs = (createSupervisedLocalHarnessProvider.mock.calls as unknown[][])[0][0] as any;
    expect(providerArgs.scopedEnv).toEqual({ SERVICE_KEY: "test-value" });
    expect(delivered).not.toHaveBeenCalled();
    await providerArgs.onBridgeStarted({ pid: 1, port: 1 });
    expect(delivered).toHaveBeenCalledOnce();
    await result.prepared.discardState();
  });

  it("lands composer attachments in the session's own state, never the workspace", async () => {
    const result = await prepareLocalHarnessTurn(turnArgs());
    if (!result.ok) throw new Error(result.message);
    const providerArgs = (createSupervisedLocalHarnessProvider.mock.calls as unknown[][])[0][0] as any;
    const attachments = join(providerArgs.sessionStateDir, "attachments");
    // Inside the state root the session's file API is confined to, and
    // outside the user's checkout.
    expect(result.prepared.attachmentsDir).toEqual({
      writeDir: toAdapterPath(attachments),
      agentDir: attachments,
    });
    expect(providerArgs.workspacePath).toEqual(expect.any(String));
    expect(attachments.startsWith(providerArgs.workspacePath)).toBe(false);
    await result.prepared.discardState();
  });

  it("records each bridge start against the pack it ran on — the signal that rolls a bad update back", async () => {
    const { noteRuntimeLaunch } = await import("../runtime-install.js");
    const result = await prepareLocalHarnessTurn(turnArgs());
    if (!result.ok) throw new Error(result.message);
    const providerArgs = (createSupervisedLocalHarnessProvider.mock.calls as unknown[][]).at(-1)![0] as any;
    await providerArgs.onBridgeStarted({ pid: 1, port: 1 });
    expect(noteRuntimeLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: { ok: true }, status: expect.objectContaining({ packVersion: "test-pack-1" }) }),
    );
    providerArgs.onBridgeFailed({ phase: "readiness", message: "bridge never listened" });
    expect(noteRuntimeLaunch).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: { ok: false, reason: "readiness: bridge never listened" } }),
    );
    await result.prepared.discardState();
  });

  it("reports missing state before mkdir, including after a previous turn discarded it", async () => {
    const args = turnArgs();
    const first = await prepareLocalHarnessTurn(args);
    if (!first.ok) throw new Error(first.message);
    expect(first.prepared.sessionStateExists).toBe(false);
    await first.prepared.teardown();

    const second = await prepareLocalHarnessTurn(args);
    if (!second.ok) throw new Error(second.message);
    expect(second.prepared.sessionStateExists).toBe(true);
    await second.prepared.discardState();

    const third = await prepareLocalHarnessTurn(args);
    if (!third.ok) throw new Error(third.message);
    expect(third.prepared.sessionStateExists).toBe(false);
    await third.prepared.discardState();
  });

  it("validates session ids before minting a broker lease", async () => {
    await expect(prepareLocalHarnessTurn({ ...turnArgs(), sessionId: "../escape" })).rejects.toThrow("safe path segment");
    expect(startLoopbackModelBroker).not.toHaveBeenCalled();
  });

  it("refuses to reuse an identity whose previous tree has not stopped", async () => {
    const args = turnArgs();
    const first = await prepareLocalHarnessTurn(args);
    if (!first.ok) throw new Error(first.message);
    const second = await prepareLocalHarnessTurn(args);
    expect(second).toMatchObject({ ok: false, status: "session-still-running" });
    expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
    await first.prepared.teardown();
  });

  it("keeps state across turn teardown and deletes it when the lane ends", async () => {
    const args = turnArgs();
    const result = await prepareLocalHarnessTurn(args);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stateFile = join(`${stateRoot}-sessions`, args.sessionId, "transcript");
    await writeFile(stateFile, "prior turn");
    await result.prepared.teardown();
    expect(await readFile(stateFile, "utf8")).toBe("prior turn");
    await result.prepared.discardState();
    await expect(readFile(stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps state if a process survives teardown", async () => {
    const args = turnArgs();
    const result = await prepareLocalHarnessTurn(args);
    if (!result.ok) throw new Error(result.message);
    const stateFile = join(`${stateRoot}-sessions`, args.sessionId, "transcript");
    await writeFile(stateFile, "prior turn");
    supervisorFixture.stopOutcome = { stopped: false, escaped: 1 };
    await result.prepared.discardState();
    expect(await readFile(stateFile, "utf8")).toBe("prior turn");
  });
});

function codexArgs(overrides: Record<string, unknown> = {}) {
  return {
    ...turnArgs(),
    harnessId: "codex" as const,
    modelId: "openai/gpt-5.5",
    ...overrides,
  } as unknown as Parameters<typeof prepareLocalHarnessTurn>[0];
}

describe("local Codex", () => {
  it("gets the capability as CODEX_API_KEY over the gateway's bare origin, with skills under .agents", async () => {
    const result = await prepareLocalHarnessTurn(codexArgs());
    if (!result.ok) throw new Error(result.message);
    // Bare origin: Codex appends `/responses`, and the gateway forwards exactly
    // that under the broker's own `/openai/v1`.
    expect(result.prepared.auth).toEqual({
      CODEX_API_KEY: "cap",
      OPENAI_BASE_URL: "http://127.0.0.1:1",
    });
    expect(`${result.prepared.homeDir}/${HARNESS_SKILLS.codex.writeFolder}`).toMatch(/[/\\]\.agents[/\\]skills$/);
    expect(createSupervisedLocalHarnessProvider).toHaveBeenCalledWith(
      expect.objectContaining({ harnessId: "codex" }),
    );
    await result.prepared.teardown();
  });

  it("refuses OPENAI_ and CODEX_ project secrets for Codex only", async () => {
    await expect(
      prepareLocalHarnessTurn(codexArgs({ scopedEnv: { OPENAI_API_KEY: "k" } })),
    ).rejects.toThrow(/conflicts with the local harness runtime/);
    await expect(
      prepareLocalHarnessTurn(codexArgs({ scopedEnv: { CODEX_HOME: "/x" } })),
    ).rejects.toThrow();
    // A Claude Code project may carry an OPENAI_API_KEY for its MCP server.
    const claude = await prepareLocalHarnessTurn({
      ...turnArgs(),
      scopedEnv: { OPENAI_API_KEY: "k" },
    } as never);
    expect(claude.ok).toBe(true);
    if (claude.ok) await claude.prepared.teardown();
  });
});

describe.each(["codex", "claude-code"] as const)("a local %s runtime parked on an approval", (harnessId) => {
  const runtimeArgs = (overrides: Record<string, unknown> = {}) => ({
    ...codexArgs(overrides), harnessId,
    modelId: harnessId === "codex" ? "openai/gpt-5.5" : "claude-haiku",
  });
  async function parkedSession() {
    const first = await prepareLocalHarnessTurn(runtimeArgs());
    if (!first.ok) throw new Error(first.message);
    expect(
      first.prepared.park({ generation: "gen-1", pendingApprovalIds: ["approval-1"] }),
    ).not.toBeNull();
    return first.prepared;
  }

  it("holds model traffic and revokes the lease while it waits", async () => {
    await parkedSession();
    expect(gatewayHold).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(revokeHarnessModelBroker).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run_1" }),
      ),
    );
    // Still registered (stop-all can reach it) and not torn down.
    expect(getLocalHarnessSession("s_local_1")).toBeDefined();
    expect(supervisorFixture.stopCalls).toBe(0);
    expect(describeParkedLocalSession("s_local_1")?.state).toBe("awaiting-approval");
  });

  it("is re-adopted for the decision with a FRESH lease on the same gateway", async () => {
    const parked = await parkedSession();
    startLoopbackModelBroker.mockResolvedValueOnce({
      ok: true,
      runId: "run_2",
      expiresAt: Date.now() + 60_000,
      protocol: "openai" as never,
      proxyBaseUrl: "https://api.example.test/proxy",
      delivery: "inspector-loopback-gateway",
      lease: "lease.two.value",
    });
    const adopted = await prepareLocalHarnessTurn(
      runtimeArgs({
        requireToolApproval: false,
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }),
    );
    if (!adopted.ok) throw new Error(adopted.message);
    // The same live process: same provider, same capability and gateway.
    expect(adopted.prepared.sandbox).toBe(parked.sandbox);
    expect(adopted.prepared.sandbox.forbidNewProcesses).toHaveBeenCalledOnce();
    expect(adopted.prepared.auth).toEqual(parked.auth);
    expect(startLocalModelGateway).toHaveBeenCalledOnce();
    expect(gatewayRebind).toHaveBeenCalledWith("lease.two.value");
    expect(adopted.prepared.brokerRunId).toBe("run_2");
    // Teardown after the continuation revokes the CURRENT lease.
    adopted.prepared.unpark();
    await adopted.prepared.teardown();
    expect(revokeHarnessModelBroker).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_2" }),
    );
  });

  it("refuses the same decision a second time", async () => {
    await parkedSession();
    const continuation = {
      approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
    };
    const first = await prepareLocalHarnessTurn(runtimeArgs(continuation));
    expect(first.ok).toBe(true);
    const again = await prepareLocalHarnessTurn(runtimeArgs(continuation));
    expect(again).toMatchObject({ ok: false, status: "approval-duplicate-approval" });
  });

  it("ends the session when the renewed lease cannot be obtained; nothing runs", async () => {
    await parkedSession();
    startLoopbackModelBroker.mockResolvedValueOnce({
      ok: false,
      error: "lease refused",
    } as never);
    const adopted = await prepareLocalHarnessTurn(
      runtimeArgs({
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }),
    );
    expect(adopted).toMatchObject({ ok: false, status: "broker-unavailable" });
    expect(gatewayRebind).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(supervisorFixture.stopCalls).toBe(1));
    expect(getLocalHarnessSession("s_local_1")).toBeUndefined();
  });

  it("refuses a decision for a process that died, without starting another", async () => {
    await parkedSession();
    supervisorFixture.live = 0;
    const adopted = await prepareLocalHarnessTurn(
      runtimeArgs({
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }),
    );
    expect(adopted).toMatchObject({ ok: false, status: "approval-process-died" });
    expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
  });

  it("refuses when the process dies while the decision is being delivered", async () => {
    await parkedSession();
    // Alive at claim time, gone by the time the renewed lease comes back.
    startLoopbackModelBroker.mockImplementationOnce(async () => {
      supervisorFixture.live = 0;
      return {
        ok: true,
        runId: "run_2",
        expiresAt: Date.now() + 60_000,
        protocol: "openai" as never,
        proxyBaseUrl: "https://api.example.test/proxy",
        delivery: "inspector-loopback-gateway",
        lease: "lease.two.value",
      };
    });
    const adopted = await prepareLocalHarnessTurn(
      runtimeArgs({
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }),
    );
    expect(adopted).toMatchObject({ ok: false, status: "approval-process-died" });
    expect(gatewayRebind).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(revokeHarnessModelBroker).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run_2" }),
      ),
    );
  });

  it("is ended — not re-adopted — when a new prompt arrives instead of a decision", async () => {
    await parkedSession();
    const fresh = await prepareLocalHarnessTurn(runtimeArgs());
    // The parked tree was stopped first, then a fresh one prepared.
    expect(supervisorFixture.stopCalls).toBe(1);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) await fresh.prepared.teardown();
    expect(describeParkedLocalSession("s_local_1")?.state ?? "terminal").toBe("terminal");
  });

  it("stops accepting the decision the moment Stop is pressed", async () => {
    await parkedSession();
    await endLocalHarnessSession("s_local_1");
    const adopted = await prepareLocalHarnessTurn(
      runtimeArgs({
        approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
      }),
    );
    expect(adopted).toMatchObject({ ok: false, status: "approval-terminal" });
  });
});

it("reads the runtime selection once a turn, taking the one readiness resolved the target from", async () => {
  const args = codexArgs();
  noteTurnRuntimeStatus(args.target, {
    state: "ready",
    packVersion: "test-pack-1",
    digest: `sha256:${"a".repeat(64)}`,
    runtimeRoot: "/nonexistent/runtime-root",
  });
  const first = await prepareLocalHarnessTurn(args);
  if (!first.ok) throw new Error(first.message);
  expect(readRuntimeInstallStatus).not.toHaveBeenCalled();
  await first.prepared.teardown();
  // Taken once: the same target prepared again (or one readiness did not
  // mint) reads the selection itself.
  const again = await prepareLocalHarnessTurn(args);
  if (!again.ok) throw new Error(again.message);
  expect(readRuntimeInstallStatus).toHaveBeenCalledOnce();
  await again.prepared.teardown();
});
it("verifies a fresh turn's runtime once, at the spawn, and an adopted runtime's own pack again", async () => {
  // The provider re-verifies right before it spawns (`assertCanStart`), so a
  // fresh turn does not ask the availability gate to verify it again. A parked
  // process is not done with its pack: its bridge starts a new vendor process
  // from it when the runtime configuration changes or the app-server dies.
  const fresh = await prepareLocalHarnessTurn(codexArgs());
  if (!fresh.ok) throw new Error(fresh.message);
  expect(resolveLocalHarnessAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ runtimeVerifiedAtSpawn: true }));
  expect(revalidateRuntime).not.toHaveBeenCalled();
  expect(fresh.prepared.park({ generation: "gen-1", pendingApprovalIds: ["approval-1"] })).not.toBeNull();
  const adopted = await prepareLocalHarnessTurn(codexArgs({
    approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
  }));
  if (!adopted.ok) throw new Error(adopted.message);
  expect(revalidateRuntime).toHaveBeenCalledOnce();
  expect(revalidateRuntime).toHaveBeenCalledWith(fresh.prepared.plan.runtime);
  adopted.prepared.unpark();
  await adopted.prepared.teardown();
});
it("refuses to hand an approval to a runtime whose pack changed while it waited", async () => {
  const fresh = await prepareLocalHarnessTurn(codexArgs());
  if (!fresh.ok) throw new Error(fresh.message);
  expect(fresh.prepared.park({ generation: "gen-1", pendingApprovalIds: ["approval-1"] })).not.toBeNull();
  revalidateRuntime.mockResolvedValueOnce({ ok: false, message: "the codex runtime bundle changed after consent was granted" });
  const adopted = await prepareLocalHarnessTurn(codexArgs({
    approvalContinuation: { generation: "gen-1", approvalIds: ["approval-1"] },
  }));
  expect(adopted).toMatchObject({ ok: false, status: "runtime-changed" });
  // No lease for it, and the parked process is ended.
  expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(supervisorFixture.stopCalls).toBe(1));
  expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "authorization-revoked" });
});
it("refuses Off without acknowledgement before spawning or minting a lease", async () => {
  vi.mocked(readLocalHarnessAuthorization).mockResolvedValueOnce(null);
  expect(await prepareLocalHarnessTurn({ ...turnArgs(), requireToolApproval: false })).toMatchObject({ ok: false, status: "auto-approve-consent-required" });
  expect(startLoopbackModelBroker).not.toHaveBeenCalled();
  expect(createSupervisedLocalHarnessProvider).not.toHaveBeenCalled();
});
it.each([true, false])("keeps attended ask mode with Tool Approval=%s", async requireToolApproval => {
  const result = await prepareLocalHarnessTurn({ ...turnArgs(), requireToolApproval });
  if (!result.ok) throw new Error(result.message);
  expect(result.prepared.permissionMode).toBe("allow-reads");
  await result.prepared.teardown();
});

describe("a local Codex runtime kept between turns", () => {
  // As in production: nothing is kept, or adopted, with the switch off.
  beforeEach(() => vi.stubEnv("MCPJAM_LOCAL_KEEP_AGENT", "true"));
  afterEach(() => vi.unstubAllEnvs());
  const CONFIG = { fingerprint: "config-a" };
  const READY = {
    state: "ready" as const,
    packVersion: "test-pack-1",
    digest: `sha256:${"a".repeat(64)}`,
    runtimeRoot: "/nonexistent/runtime-root",
  };
  const bridge = (token = "gen-1") => ({
    type: "resume-session",
    data: { bridge: { port: 4100, token } },
  });
  const nextTurn = (overrides: Record<string, unknown> = {}) =>
    codexArgs({
      keptRuntime: { ...CONFIG, committed: { generation: "gen-1", stateVersion: 2 } },
      reasoningEffort: "high",
      ...overrides,
    });
  const lease = (runId: string, extra: Record<string, unknown> = {}) => ({
    ok: true as const,
    runId,
    expiresAt: Date.now() + 60_000,
    protocol: "openai" as never,
    proxyBaseUrl: "https://api.example.test/proxy",
    delivery: "inspector-loopback-gateway" as const,
    lease: `lease.${runId}.value`,
    ...extra,
  });

  /** A first turn that completed, committed state version 2, and kept its runtime. */
  async function keptSession(
    overrides: Record<string, unknown> = {},
    toolCalls: readonly { toolName: string; serverId?: string }[] = [],
  ) {
    const first = await prepareLocalHarnessTurn(codexArgs({ keptRuntime: CONFIG, ...overrides }));
    if (!first.ok) throw new Error(first.message);
    const park = await first.prepared.parkTurn({ kept: CONFIG, resumeState: bridge(), stateVersion: 2, toolCalls });
    return { prepared: first.prepared, park, kept: park !== null };
  }

  it("holds model traffic and revokes the lease while it waits, so it makes no model call", async () => {
    const { kept } = await keptSession();
    expect(kept).toBe(true);
    expect(gatewayHold).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(revokeHarnessModelBroker).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_1" })),
    );
    // Still registered (stop-all reaches it) and running, with no lease of its own.
    expect(getLocalHarnessSession("s_local_1")).toBeDefined();
    expect(supervisorFixture.stopCalls).toBe(0);
    expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
    expect(describeParkedLocalSession("s_local_1")?.state).toBe("idle");
  });

  it("is adopted by the next turn: the same process and gateway, a fresh lease and wall-clock budget", async () => {
    const { prepared: parked } = await keptSession();
    startLoopbackModelBroker.mockResolvedValueOnce(lease("run_2"));
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(next.prepared.keptRuntime).toBe(true);
    expect(next.prepared.sandbox).toBe(parked.sandbox);
    expect(next.prepared.auth).toEqual(parked.auth);
    expect(next.prepared.sessionStateExists).toBe(true);
    // A dead bridge is never respawned under the adopted provider.
    expect(parked.sandbox.forbidNewProcesses).toHaveBeenCalledWith(expect.stringMatching(/Send your message again/));
    expect(startLocalModelGateway).toHaveBeenCalledOnce();
    expect(gatewayRebind).toHaveBeenCalledWith("lease.run_2.value");
    expect(startLoopbackModelBroker).toHaveBeenLastCalledWith(expect.objectContaining({ reasoningEffort: "high" }));
    expect(next.prepared.brokerRunId).toBe("run_2");
    expect(supervisorFixture.wallClockRestarts).toEqual(["s_local_1"]);
    // Re-authorized with this turn's grant, and its own pack re-verified.
    expect(resolveLocalHarnessAvailability).toHaveBeenLastCalledWith(
      expect.objectContaining({ grantToken: "grant-token" }),
    );
    expect(revalidateRuntime).toHaveBeenCalledWith(parked.plan.runtime);
    // Kept again at its end, for the state version the next commit produces.
    expect(await next.prepared.parkTurn({ kept: CONFIG, resumeState: bridge(), stateVersion: 3, toolCalls: [] })).not.toBeNull();
    expect(describeParkedLocalSession("s_local_1")?.state).toBe("idle");
  });

  it("keeps running for the turn that adopted it when the turn that kept it aborts late", async () => {
    // N commits and keeps its runtime, N+1 adopts it, then N's request aborts:
    // N's Stop (and its finalizer) reach only the park N made, while it waits.
    const { park } = await keptSession();
    startLoopbackModelBroker.mockResolvedValueOnce(lease("run_2"));
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(next.prepared.keptRuntime).toBe(true);
    await endParkIfWaiting(park!, "stopped");
    expect(supervisorFixture.stopCalls).toBe(0);
    expect(getLocalHarnessSession("s_local_1")).toBeDefined();
    expect(describeParkedLocalSession("s_local_1")?.state).toBe("continuing");
    // N+1 keeps it again; N's park is still not the one held.
    expect(await next.prepared.parkTurn({ kept: CONFIG, resumeState: bridge(), stateVersion: 3, toolCalls: [] })).not.toBeNull();
    await endParkIfWaiting(park!, "continuation-failed");
    expect(supervisorFixture.stopCalls).toBe(0);
    expect(describeParkedLocalSession("s_local_1")?.state).toBe("idle");
  });

  it.each([
    ["another configuration", { keptRuntime: { fingerprint: "config-b", committed: { generation: "gen-1", stateVersion: 2 } } }, "configuration-changed"],
    ["a state version another Inspector's turn moved on", { keptRuntime: { ...CONFIG, committed: { generation: "gen-1", stateVersion: 3 } } }, "superseded"],
    ["another bridge generation", { keptRuntime: { ...CONFIG, committed: { generation: "gen-2", stateVersion: 2 } } }, "superseded"],
    ["a lane that names no runtime", { keptRuntime: CONFIG }, "superseded"],
    ["a turn that asks for nothing", { keptRuntime: undefined }, "superseded"],
  ])("is ended, and the turn starts fresh, for %s", async (_label, overrides, reason) => {
    await keptSession();
    const next = await prepareLocalHarnessTurn(nextTurn(overrides));
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ state: "terminal", invalidatedBy: reason });
    expect(next.prepared.keptRuntime).toBeUndefined();
    expect(supervisorFixture.stopCalls).toBe(1);
    expect(startLocalModelGateway).toHaveBeenCalledTimes(2);
    expect(gatewayRebind).not.toHaveBeenCalled();
    await next.prepared.teardown();
  });

  it("is ended, and the turn starts fresh, when its process died", async () => {
    await keptSession();
    supervisorFixture.live = 0;
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "process-died" });
    expect(startLocalModelGateway).toHaveBeenCalledTimes(2);
    await next.prepared.teardown();
  });

  it.each([
    ["an install is in flight", { ...READY, role: "permitted", update: { state: "downloading", packVersion: "test-pack-2", percent: 10 } }],
    ["a fresh turn would select another pack", { ...READY, packVersion: "test-pack-2", digest: `sha256:${"b".repeat(64)}` }],
  ])("is ended, and the turn starts fresh, when %s", async (_label, status) => {
    await keptSession();
    readRuntimeInstallStatus.mockResolvedValueOnce(status as never);
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "runtime-update" });
    expect(next.prepared.keptRuntime).toBeUndefined();
    await next.prepared.teardown();
  });

  it("is ended when the availability gate refuses (the kill switch, a revoked grant), and so is the turn", async () => {
    await keptSession();
    const refused = { available: false, status: "server-disabled", message: "Local execution is off." };
    resolveLocalHarnessAvailability.mockResolvedValueOnce(refused as never).mockResolvedValueOnce(refused as never);
    const next = await prepareLocalHarnessTurn(nextTurn());
    expect(next).toMatchObject({ ok: false, status: "server-disabled" });
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "authorization-revoked" });
    // Neither the kept runtime nor a fresh one got a lease.
    expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
    expect(gatewayRebind).not.toHaveBeenCalled();
  });

  it.each([
    ["the installation is no longer registered", () => { identityFixture.keyId = null; }, "authorization-revoked"],
    ["the grant now names another runtime", () => {
      resolveLocalHarnessAvailability.mockImplementationOnce(async () => {
        const result = await resolveLocalHarnessAvailability.getMockImplementation()!({});
        return { ...result, plan: { ...result.plan, runtime: { ...result.plan.runtime, runtimeId: "rt_2" } } };
      });
    }, "authorization-revoked"],
    ["the renewed lease cannot be bound", () => {
      gatewayRebind.mockImplementationOnce(() => { throw new Error("unusable lease"); });
    }, "renewal-failed"],
  ] as const)("is ended when %s", async (_label, arrange, reason) => {
    await keptSession();
    arrange();
    const next = await prepareLocalHarnessTurn(nextTurn());
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: reason });
    if (next.ok) {
      expect(next.prepared.keptRuntime).toBeUndefined();
      await next.prepared.teardown();
    }
  });

  it("is ended when its pack changed while it waited, and the turn starts fresh", async () => {
    await keptSession();
    revalidateRuntime.mockResolvedValueOnce({ ok: false, message: "the codex runtime bundle changed after consent was granted" });
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "authorization-revoked" });
    expect(next.prepared.keptRuntime).toBeUndefined();
    expect(gatewayRebind).not.toHaveBeenCalled();
    await next.prepared.teardown();
  });

  it("is ended when its renewed lease is refused, and the turn starts fresh", async () => {
    await keptSession();
    startLoopbackModelBroker.mockResolvedValueOnce({ ok: false, error: "lease refused" } as never);
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "renewal-failed" });
    expect(next.prepared.keptRuntime).toBeUndefined();
    await next.prepared.teardown();
  });

  it("is ended when the organization's key was replaced while it waited", async () => {
    const orgUpstream = (credentialRevision: string) => ({
      credentialSource: "org" as const,
      profile: "openai-native" as const,
      nativeModelId: "gpt-5.5",
      credentialRevision,
    });
    startLoopbackModelBroker.mockResolvedValueOnce(lease("run_1", { orgUpstream: orgUpstream("rev-1") }));
    await keptSession();
    startLoopbackModelBroker.mockResolvedValueOnce(lease("run_2", { orgUpstream: orgUpstream("rev-2") }));
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "renewal-failed" });
    // The lease minted on the replaced key is revoked, never bound.
    expect(revokeHarnessModelBroker).toHaveBeenCalledWith(expect.objectContaining({ runId: "run_2" }));
    expect(next.prepared.keptRuntime).toBeUndefined();
    await next.prepared.teardown();
  });

  it("is not adopted by a turn that may not run, which ends it", async () => {
    await keptSession();
    // Tool Approval off without the "Run without asking" acknowledgement.
    vi.mocked(readLocalHarnessAuthorization).mockResolvedValueOnce(null);
    const next = await prepareLocalHarnessTurn(nextTurn({ requireToolApproval: false }));
    expect(next).toMatchObject({ ok: false, status: "auto-approve-consent-required" });
    expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "superseded" });
    expect(startLoopbackModelBroker).toHaveBeenCalledOnce();
    expect(gatewayRebind).not.toHaveBeenCalled();
  });

  describe("tells the turn's event", () => {
    /**
     * The next turn, through the event record a real turn hands it, and
     * started from the committed state as `runHarnessTurn` starts it.
     */
    async function reported(overrides: Record<string, unknown> = {}) {
      const sink = { surface: "web" as const, capture: vi.fn() };
      const record = new HarnessTurnRecord(
        new TurnTiming({ harnessTurnEvent: sink }),
        "codex",
        true,
      );
      const next = await prepareLocalHarnessTurn(
        nextTurn({ onKeptRuntime: record.keptRuntime, ...overrides }),
      );
      if (!next.ok) throw new Error(next.message);
      record.sessionStarted({ approval: false, resumed: true, resetReason: undefined });
      record.close({ aborted: false, completed: true, bootstrap: undefined });
      await next.prepared.teardown();
      return {
        next: next.prepared,
        event: sink.capture.mock.calls[0]![0] as HarnessTurnEventProperties,
      };
    }

    it("that it adopted the kept runtime: a warm start on this machine", async () => {
      await keptSession();
      startLoopbackModelBroker.mockResolvedValueOnce(lease("run_2"));
      const { next, event } = await reported();
      expect(next.keptRuntime).toBe(true);
      expect(event).toMatchObject({ surface: "local", start: "warm", fallback_reason: "none" });
    });

    it.each<[string, () => void, Record<string, unknown>, string]>([
      ["it runs another configuration", () => {}, {
        keptRuntime: { fingerprint: "config-b", committed: { generation: "gen-1", stateVersion: 2 } },
      }, "configuration_changed"],
      ["the lane moved past it", () => {}, {
        keptRuntime: { ...CONFIG, committed: { generation: "gen-1", stateVersion: 3 } },
      }, "superseded"],
      ["its process died", () => {
        supervisorFixture.live = 0;
      }, {}, "process_died"],
      ["an update replaced its pack after readiness let the turn in", () => {
        readRuntimeInstallStatus.mockResolvedValueOnce({
          ...READY, packVersion: "test-pack-2", digest: `sha256:${"b".repeat(64)}`,
        } as never);
      }, {}, "runtime_update"],
      ["its pack changed on disk", () => {
        revalidateRuntime.mockResolvedValueOnce({ ok: false, message: "the codex runtime bundle changed" });
      }, {}, "authorization_revoked"],
      ["no new lease could be had for it", () => {
        startLoopbackModelBroker.mockResolvedValueOnce({ ok: false, error: "lease refused" } as never);
      }, {}, "renewal_failed"],
    ])("why it started from saved files when %s", async (_label, arrange, overrides, reason) => {
      await keptSession();
      arrange();
      const { next, event } = await reported(overrides);
      expect(next.keptRuntime).toBeUndefined();
      expect(event).toMatchObject({ surface: "local", start: "disk_resume", fallback_reason: reason });
    });

    it("that a claim came past the kept runtime's lifetime, before its timer ended it", async () => {
      let now = Date.now();
      resetApprovalParkForTests({ now: () => now });
      await keptSession();
      now += TURN_PARK_LIFETIME_MS;
      const { event } = await reported();
      expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "lifetime" });
      expect(event).toMatchObject({ start: "disk_resume", fallback_reason: "lifetime" });
    });

    it("why it ended the kept runtime, when the turn itself is then refused", async () => {
      await keptSession();
      const refused = { available: false, status: "server-disabled", message: "Local execution is off." };
      resolveLocalHarnessAvailability.mockResolvedValueOnce(refused as never).mockResolvedValueOnce(refused as never);
      const sink = { surface: "web" as const, capture: vi.fn() };
      const record = new HarnessTurnRecord(new TurnTiming({ harnessTurnEvent: sink }), "codex", true);
      const next = await prepareLocalHarnessTurn(nextTurn({ onKeptRuntime: record.keptRuntime }));
      expect(next).toMatchObject({ ok: false, status: "server-disabled" });
      // The turn fails before any session starts, as `runHarnessTurn` closes it.
      record.close({ aborted: false, completed: false, bootstrap: undefined });
      const event = sink.capture.mock.calls[0]![0] as HarnessTurnEventProperties;
      expect(event).toMatchObject({ surface: "local", outcome: "failed", fallback_reason: "authorization_revoked" });
      expect(event).not.toHaveProperty("start");
    });

    it("nothing about a kept runtime the person stopped", async () => {
      await keptSession();
      await endLocalHarnessSession("s_local_1");
      const { event } = await reported();
      expect(event).toMatchObject({ start: "disk_resume", fallback_reason: "none" });
    });

    describe("why the kept runtime ended before the turn came", () => {
      /** The registry's clock, whose timers fire only when the test moves it on. */
      function parkClock() {
        let now = Date.now();
        const due = new Map<ReturnType<typeof setTimeout>, { at: number; fire: () => void }>();
        resetApprovalParkForTests({
          now: () => now,
          setTimer: (fire, ms) => {
            const handle = setTimeout(() => {}, 0);
            clearTimeout(handle);
            due.set(handle, { at: now + ms, fire });
            return handle;
          },
          clearTimer: (handle) => {
            due.delete(handle);
          },
        });
        return {
          /** Time passes with nothing happening: no timer fires. */
          skip: (ms: number) => {
            now += ms;
          },
          /** Time passes and every timer that comes due fires. */
          async advance(ms: number) {
            now += ms;
            for (const [handle, timer] of [...due]) {
              if (timer.at > now) continue;
              due.delete(handle);
              timer.fire();
            }
            await vi.waitFor(() => expect(supervisorFixture.stopCalls).toBeGreaterThan(0));
          },
        };
      }

      it("its idle window ran out", async () => {
        const clock = parkClock();
        await keptSession();
        await clock.advance(DEFAULT_TURN_PARK_TTL_MS);
        expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "idle-expired" });
        const { event } = await reported();
        expect(event).toMatchObject({ surface: "local", start: "disk_resume", fallback_reason: "idle_expired" });
      });

      it("its lifetime ran out", async () => {
        const clock = parkClock();
        const { prepared } = await keptSession();
        // Kept again, by later turns, until shortly before the end of its life:
        // its timer is now the lifetime's.
        clock.skip(TURN_PARK_LIFETIME_MS - 5 * 60_000);
        expect(await prepared.parkTurn({ kept: CONFIG, resumeState: bridge(), stateVersion: 2, toolCalls: [] })).not.toBeNull();
        await clock.advance(5 * 60_000);
        expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "lifetime" });
        expect((await reported()).event).toMatchObject({ start: "disk_resume", fallback_reason: "lifetime" });
      });

      it("another conversation's runtime took its slot", async () => {
        const clock = parkClock();
        await keptSession();
        for (let other = 1; other <= MAX_TURN_PARKS; other += 1) {
          clock.skip(1);
          parkLocalTurn({
            sessionId: `s_other_${other}`, generation: `gen-other-${other}`, userId: "user_1", projectId: "proj_1",
            harnessId: "codex", runtimeDigest: READY.digest, stateVersion: 1, fingerprint: "config-other",
            resources: {}, end: async () => {}, isAlive: () => true, holdModelTraffic: () => {},
          });
        }
        expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "evicted" });
        expect((await reported()).event).toMatchObject({ start: "disk_resume", fallback_reason: "evicted" });
      });

      it("Inspector shut down", async () => {
        await keptSession();
        await shutdownLocalTurnParks();
        expect((await reported()).event).toMatchObject({ start: "disk_resume", fallback_reason: "shutdown" });
      });

      it("keeping local runtimes was turned off, which ends it at the next turn", async () => {
        await keptSession();
        vi.stubEnv("MCPJAM_LOCAL_KEEP_AGENT", "false");
        // With the switch off a turn asks to adopt nothing.
        const { event } = await reported({ keptRuntime: undefined });
        expect(describeParkedLocalSession("s_local_1")).toMatchObject({ invalidatedBy: "switched-off" });
        expect(event).toMatchObject({ start: "disk_resume", fallback_reason: "switched_off" });
      });

      it("only when it is the runtime the lane's committed state names", async () => {
        const clock = parkClock();
        await keptSession();
        await clock.advance(DEFAULT_TURN_PARK_TTL_MS);
        const { event } = await reported({
          keptRuntime: { ...CONFIG, committed: { generation: "gen-2", stateVersion: 3 } },
        });
        expect(event).toMatchObject({ start: "disk_resume", fallback_reason: "none" });
      });

      it("to one turn only", async () => {
        const clock = parkClock();
        await keptSession();
        await clock.advance(DEFAULT_TURN_PARK_TTL_MS);
        expect((await reported()).event).toMatchObject({ fallback_reason: "idle_expired" });
        expect((await reported()).event).toMatchObject({ fallback_reason: "none" });
      });

      it("to a turn that comes after its tombstone is gone", async () => {
        const clock = parkClock();
        await keptSession();
        await clock.advance(DEFAULT_TURN_PARK_TTL_MS);
        // The tombstone's minute passes, and with it the registry's record.
        await clock.advance(2 * 60_000);
        expect(describeParkedLocalSession("s_local_1")).toBeNull();
        expect((await reported()).event).toMatchObject({ fallback_reason: "idle_expired" });
      });

      it("to no turn once its end is forgotten", async () => {
        const clock = parkClock();
        await keptSession();
        await clock.advance(DEFAULT_TURN_PARK_TTL_MS);
        clock.skip(KEPT_END_RETENTION_MS);
        expect((await reported()).event).toMatchObject({ fallback_reason: "none" });
      });
    });
  });

  it("stops being adoptable the moment Stop ends it", async () => {
    await keptSession();
    await endLocalHarnessSession("s_local_1");
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    expect(next.prepared.keptRuntime).toBeUndefined();
    expect(startLocalModelGateway).toHaveBeenCalledTimes(2);
    await next.prepared.teardown();
  });

  it("goes with the teardown of a turn that does not keep it again", async () => {
    await keptSession();
    startLoopbackModelBroker.mockResolvedValueOnce(lease("run_2"));
    const next = await prepareLocalHarnessTurn(nextTurn());
    if (!next.ok) throw new Error(next.message);
    // A key replaced mid-turn (`org-key-preparation.ts`) tears the adopted runtime down.
    await next.prepared.teardown();
    expect(describeParkedLocalSession("s_local_1")).toBeNull();
    expect(supervisorFixture.stopCalls).toBe(1);
  });

  it.each([
    ["a command", [{ toolName: "bash" }]],
    ["a patch, which runs through the shell", [{ toolName: "webSearch" }, { toolName: "fileChange" }]],
  ])("is never kept after a turn that ran %s, approved or not", async (_label, toolCalls) => {
    // Anything it started (a shell `exec_command` left running) would reach
    // the next turn, which could drive it without asking.
    const { kept } = await keptSession({}, toolCalls);
    expect(kept).toBe(false);
    expect(gatewayHold).not.toHaveBeenCalled();
    expect(describeParkedLocalSession("s_local_1")).toBeNull();
  });

  it("is kept after a turn that only searched, viewed images or called MCP tools", async () => {
    const { kept } = await keptSession({}, [
      { toolName: "webSearch" },
      { toolName: "imageView" },
      // An MCP server's own tool, whatever it is called, runs outside this runtime.
      { toolName: "bash", serverId: "srv_terminal" },
    ]);
    expect(kept).toBe(true);
  });

  it("is never kept with materialized secrets in its environment", async () => {
    const { kept } = await keptSession({ scopedEnv: { STRIPE_API_KEY: "sk_test_secret" } });
    expect(kept).toBe(false);
    expect(gatewayHold).not.toHaveBeenCalled();
    expect(describeParkedLocalSession("s_local_1")).toBeNull();
  });

  it("is not kept while an install may replace its pack", async () => {
    readRuntimeInstallStatus
      .mockResolvedValueOnce(READY)
      .mockResolvedValueOnce({ ...READY, role: "permitted", update: { state: "verifying", packVersion: "test-pack-2" } } as never);
    const { kept } = await keptSession();
    expect(kept).toBe(false);
    expect(describeParkedLocalSession("s_local_1")).toBeNull();
  });

  it("is not kept when the runtime selection cannot be read", async () => {
    readRuntimeInstallStatus.mockResolvedValueOnce(READY).mockRejectedValueOnce(new Error("EACCES"));
    const { kept } = await keptSession();
    expect(kept).toBe(false);
  });
});
