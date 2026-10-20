import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { reserveLoopbackPort } from "../bridge-endpoint.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import {
  computeTreeDigest,
  resolveManagedBundle,
} from "../runtime-identity.js";
import { supportsOwnershipProof } from "../process-identity.js";
import { createSupervisedLocalHarnessProvider } from "../supervised-provider.js";
import { LocalHarnessSupervisor } from "../supervisor.js";

const admission = vi.hoisted(() => ({ runtimeId: "", runtimeRoot: "" }));
vi.mock("../runtime-install.js", () => ({
  readRuntimeInstallStatus: async () => ({
    state: "ready",
    runtimeRoot: admission.runtimeRoot,
  }),
}));
vi.mock("../availability.js", () => ({
  resolveLocalHarnessAvailability: async () => ({
    available: true,
    plan: {
      runtime: { runtimeId: admission.runtimeId },
      target: { workspaceGrantId: "ws" },
    },
  }),
}));
vi.mock("../instance-key.js", () => ({
  readLocalInstanceIdentity: async () => ({
    machineId: "machine",
    keyId: "key",
  }),
  getRegisteredKeyId: () => "key",
}));
vi.mock("../../harness-model-broker.js", () => ({
  startLoopbackModelBroker: async () => ({
    ok: true,
    runId: "new-run",
    lease: "new-lease",
  }),
  revokeHarnessModelBroker: vi.fn(),
}));
import { prepareLocalHarnessTurn } from "../local-turn.js";
import {
  parkLocalSession,
  resetApprovalParkForTests,
} from "../approval-park.js";

const supervisors: LocalHarnessSupervisor[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const supervisor of supervisors.splice(0))
    await supervisor.stopSession("s1");
  resetApprovalParkForTests();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "approval-attach-")),
  );
  roots.push(root);
  vi.stubEnv("HOME", root);
  const workspace = join(root, "workspace");
  const bundle = join(root, "runtimes", "claude-code");
  await mkdir(workspace);
  await mkdir(join(bundle, "bin"), { recursive: true });
  // A real managed process with the minimum loopback listener. No model call.
  await writeFile(
    join(bundle, "bridge.mjs"),
    "import net from 'node:net'; net.createServer().listen(Number(process.env.BRIDGE_WS_PORT), '127.0.0.1');",
  );
  await writeFile(
    join(bundle, "launcher.mjs"),
    await readFile(join(import.meta.dirname, "../layer/launcher.mjs")),
  );
  await writeFile(join(bundle, "bin/node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bundle, "bin/node"), 0o755);
  const digest = await computeTreeDigest(bundle);
  const manifest = {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    adapterBootstrapFiles: ["bridge.mjs"],
    runtime: {
      ...LOCAL_HARNESS_MANIFEST["claude-code"].runtime,
      launcherSource: "pack" as const,
      bundleDigest: {
        "linux-x64": digest,
        "linux-arm64": digest,
        "darwin-arm64": digest,
        "darwin-x64": digest,
        "win32-x64": digest,
      },
    },
  };
  const resolved = await resolveManagedBundle({
    manifest,
    runtimeRoot: join(root, "runtimes"),
    platform: process.platform,
  });
  if (!resolved.ok) throw new Error(resolved.message);
  admission.runtimeId = resolved.runtime.runtimeId;
  admission.runtimeRoot = bundle;
  const supervisor = new LocalHarnessSupervisor({
    limits: { terminationGraceMs: 200, maxWallClockMs: 30_000 },
  });
  supervisors.push(supervisor);
  const starts = vi.spyOn(supervisor, "spawnSupervised");
  const bridgePort = await reserveLoopbackPort();
  const provider = createSupervisedLocalHarnessProvider({
    harnessId: "claude-code",
    manifest,
    runtime: resolved.runtime,
    supervisor,
    launcher: resolveNodeLauncher({ bundledNodePath: process.execPath }),
    workspacePath: workspace,
    workspaceGrantId: "ws",
    sessionStateDir: join(root, "session"),
    targetKind: "local-native",
    bridgePort,
  });
  const session = await provider.createSession({ sessionId: "s1" });
  const workRoot = join(root, "session", "work");
  const command = `node '${workRoot}/.harness-bootstrap/claude-code/bridge.mjs' --workdir '${workRoot}/project' --bridge-state-dir '${workRoot}/.agent-runs/s1/bridge'`;
  await session.spawn({
    command,
    env: {
      BRIDGE_WS_PORT: String(bridgePort),
      BRIDGE_CHANNEL_TOKEN: "generation",
    },
  });
  return {
    supervisor,
    starts,
    provider,
    session,
    workRoot,
    command,
    bridgePort,
  };
}

it.skipIf(!supportsOwnershipProof())(
  "blocks the real Claude adapter fallback after its adopted bridge dies",
  async () => {
    const f = await fixture();
    parkLocalSession({
      sessionId: "s1",
      generation: "generation",
      userId: "user",
      projectId: "project",
      pendingApprovalIds: ["a1"],
      isAlive: () => true,
      holdModelTraffic: () => {},
      end: async () => {
        await f.supervisor.stopSession("s1");
      },
      resources: {
        prepared: { sandbox: f.provider, permissionMode: "allow-reads" },
        runtimeId: admission.runtimeId,
        workspaceGrantId: "ws",
        rebindLease: vi.fn(),
      },
    });
    const adopted = await prepareLocalHarnessTurn({
      target: {
        kind: "local-native",
        machineId: "machine",
        runtimeId: admission.runtimeId,
        workspaceGrantId: "ws",
        permissionProfile: "workspace-edits",
        policyVersion: "v1",
        grantToken: "grant",
        actingUserId: "user",
      },
      harnessId: "claude-code",
      modelId: "anthropic/claude-haiku-4.5",
      sessionId: "s1",
      runId: "new-run",
      actor: { kind: "member" },
      projectId: "project",
      bearer: "Bearer fixture",
      installedAdapterVersion: "1.0.121",
      approvalContinuation: { generation: "generation", approvalIds: ["a1"] },
    });
    expect(adopted.ok).toBe(true);
    expect((await f.supervisor.stopSession("s1")).stopped).toBe(true);
    const adapter = createClaudeCode({
      startupTimeoutMs: 100,
      auth: { ANTHROPIC_API_KEY: "fixture-key" },
    });
    await expect(
      adapter.doStart({
        sessionId: "s1",
        sessionWorkDir: `${f.workRoot}/project`,
        sandboxSession: f.session,
        continueFrom: {
          type: "continue-turn",
          harnessId: "claude-code",
          specificationVersion: "harness-v1",
          data: {
            claudeSessionId: "native-1",
            bridge: {
              port: f.bridgePort,
              token: "generation",
              lastSeenEventId: 1,
            },
          },
          pendingToolApprovals: [
            {
              approvalId: "a1",
              toolCallId: "call-1",
              toolName: "bash",
              input: "{}",
              kind: "builtin",
            },
          ],
        },
      }),
    ).rejects.toThrow(/pending action will not run/);
    expect(f.starts).toHaveBeenCalledTimes(1);
    // The latch survives Stop and also covers the provider's run path.
    await expect(f.session.run({ command: f.command })).rejects.toThrow(
      /pending action will not run/,
    );
    expect(f.starts).toHaveBeenCalledTimes(1);
  },
);

it.skipIf(!supportsOwnershipProof())(
  "allows a fresh provider to start a normal local process",
  async () => {
    const f = await fixture();
    expect(f.starts).toHaveBeenCalledTimes(1);
    expect((await f.supervisor.stopSession("s1")).stopped).toBe(true);
    await f.session.spawn({
      command: f.command,
      env: { BRIDGE_WS_PORT: String(f.bridgePort) },
    });
    expect(f.starts).toHaveBeenCalledTimes(2);
  },
);
