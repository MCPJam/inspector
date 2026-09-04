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
    runtimeRoot: "/nonexistent/runtime-root",
  }),
}));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({
    machineId: "machine_1",
    publicKey: "pub",
    keyId: "key_1",
  }),
  getRegisteredKeyId: () => "key_1",
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

const { prepareLocalHarnessTurn } = await import("../local-turn.js");
const { getLocalHarnessSession, listLocalHarnessSessions } = await import(
  "../session-registry.js"
);

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

beforeEach(async () => {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-turn-")));
  stateRoot = tempDir;
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
});
