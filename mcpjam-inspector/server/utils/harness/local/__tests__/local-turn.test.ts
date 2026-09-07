import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const startLocalModelGateway = vi.fn(async () => ({
  baseUrl: "http://127.0.0.1:1",
  port: 1,
  sessionCapability: "cap",
  revoke: gatewayRevoke,
  close: gatewayClose,
  stats: () => ({ requests: 0, rejected: 0, forwarded: 0, upstreamErrors: 0 }),
}));
const resolveNodeLauncher = vi.fn(() => ({ command: "node", args: [] }));
const createSupervisedLocalHarnessProvider = vi.fn(() => ({}) as never);

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
vi.mock("../supervised-provider.js", () => ({
  createSupervisedLocalHarnessProvider: (...a: unknown[]) =>
    createSupervisedLocalHarnessProvider(...(a as [])),
}));
vi.mock("../runtime-install.js", () => ({
  readRuntimeInstallStatus: async () => ({
    state: "ready",
    // A pack version and digest as well, because the turn now takes a runtime
    // USE reservation keyed on the pack identity before it verifies anything —
    // that reservation is what stops another Inspector replacing the tree these
    // children execute from.
    packVersion: "test-pack-1",
    digest: `sha256:${"a".repeat(64)}`,
    // The RUNTIME root stays unreachable: these tests are about what happens
    // when a later step fails, and the bundle never has to resolve.
    runtimeRoot: "/nonexistent/runtime-root",
  }),
  // The INSTALL root must be writable, though — the reservation is a real file
  // in a real directory. Pointing it at `/nonexistent` made every test in this
  // file fail with EACCES on any machine that is not root, which is what CI
  // caught and a root-owned sandbox did not.
  runtimeInstallRoot: () => installRoot,
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
vi.mock("../availability.js", () => ({
  resolveLocalHarnessAvailability: async () => ({
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
  }),
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
  },
}));

const { prepareLocalHarnessTurn } = await import("../local-turn.js");
// Real, not mocked: whether a reservation is still held is the subject here.
const { runtimeUseState } = await import("../runtime-lifecycle.js");
const { localPackTarget } = await import("../targets.js");
const {
  endLocalHarnessSession,
  getLocalHarnessSession,
  listLocalHarnessSessions,
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
  // `reset`, not `clear`: a `…Once` override that a failing test never consumed
  // would otherwise leak into the next one. Vitest 3's reset restores the
  // implementation each spy was created with, which is the base behaviour here.
  vi.resetAllMocks();
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
    await writeFile(blocked, "");
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

describe("a local setup that succeeds", () => {
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
