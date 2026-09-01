import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import { readProcessBirthIdentity, supportsOwnershipProof } from "../process-identity.js";
import { listProcessRecords } from "../process-registry.js";
import { computeTreeDigest, resolveManagedBundle } from "../runtime-identity.js";
import {
  createSupervisedLocalHarnessProvider,
  sessionStateDirFor,
} from "../supervised-provider.js";
import { LocalHarnessSupervisor } from "../supervisor.js";
import { localHarnessStateRoot } from "../grants.js";

const canOwnProcesses = supportsOwnershipProof();

let base: string;
let workspace: string;
let runtimeRoot: string;
let bundleRoot: string;
let outside: string;
const realHome = process.env.HOME;

/**
 * A stand-in for the CI-built managed bundle: the same shape (a `bridge.mjs`
 * beside its dependencies), small enough to digest in a test. The real bundle
 * differs only in what is inside it.
 */
const FAKE_BRIDGE = [
  "const args = process.argv.slice(2);",
  "const out = { args, home: process.env.HOME, cwd: process.cwd(), gateway: process.env.MCPJAM_GATEWAY_URL };",
  "console.log(JSON.stringify(out));",
  "setInterval(function(){}, 1000);",
].join("\n");

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-provider-")));
  process.env.HOME = base;
  workspace = join(base, "project");
  outside = join(base, "outside");
  runtimeRoot = join(base, "runtimes");
  bundleRoot = join(runtimeRoot, "claude-code");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(bundleRoot, { recursive: true });
  await writeFile(join(workspace, "src", "existing.ts"), "export const a = 1;\n");
  await writeFile(join(outside, "secret.txt"), "shh");
  await writeFile(join(bundleRoot, "bridge.mjs"), FAKE_BRIDGE);
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

async function buildSession(
  sessionId: string,
  supervisor: LocalHarnessSupervisor,
  onBridgeStarted?: (a: { pid: number; port: number }) => Promise<void>
): Promise<{ session: HarnessV1NetworkSandboxSession; sessionStateDir: string }> {
  const digest = await computeTreeDigest(bundleRoot);
  const manifest = {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    runtime: {
      ...LOCAL_HARNESS_MANIFEST["claude-code"].runtime,
      bundleDigest: digest,
    },
  } as (typeof LOCAL_HARNESS_MANIFEST)["claude-code"];
  const resolved = await resolveManagedBundle({
    manifest,
    runtimeRoot,
    platform: "linux",
  });
  if (!resolved.ok) throw new Error(`bundle did not resolve: ${resolved.message}`);

  const sessionStateDir = sessionStateDirFor(localHarnessStateRoot(), sessionId);
  await mkdir(sessionStateDir, { recursive: true, mode: 0o700 });

  const provider = createSupervisedLocalHarnessProvider({
    harnessId: "claude-code",
    manifest,
    runtime: resolved.runtime,
    supervisor,
    launcher: resolveNodeLauncher({ isElectron: false }),
    workspacePath: workspace,
    workspaceGrantId: "ws_test",
    sessionStateDir,
    targetKind: "local-native",
    bridgePort: 39271,
    scopedEnv: { MCPJAM_GATEWAY_URL: "http://127.0.0.1:39400/gateway" },
    ...(onBridgeStarted ? { onBridgeStarted } : {}),
  });
  const session = await provider.createSession({ sessionId });
  return { session, sessionStateDir };
}

function supervisor() {
  return new LocalHarnessSupervisor({
    limits: { terminationGraceMs: 400, maxWallClockMs: 30_000 },
  });
}

describe("the AI SDK sandbox contract, over a supervised host process", () => {
  it("advertises itself honestly and omits what it cannot enforce", async () => {
    const sup = supervisor();
    const { session } = await buildSession("contract", sup);
    expect(session.description).toMatch(/NOT an isolated sandbox/);
    expect(session.description).toMatch(/operating-system user's authority/);
    // A no-op `setNetworkPolicy` would let a caller believe a policy applied.
    expect(session.setNetworkPolicy).toBeUndefined();
    // `restricted()` is the same resource with a narrower type.
    expect(session.restricted()).toBe(session);
    await session.stop();
  });

  it("reads and writes inside the granted roots", async () => {
    const sup = supervisor();
    const { session } = await buildSession("files", sup);
    await expect(
      session.readTextFile({ path: join(workspace, "src", "existing.ts") })
    ).resolves.toBe("export const a = 1;\n");

    await session.writeTextFile({
      path: join(workspace, "src", "generated", "new.ts"),
      content: "export const b = 2;\n",
    });
    await expect(
      readFile(join(workspace, "src", "generated", "new.ts"), "utf8")
    ).resolves.toBe("export const b = 2;\n");

    await session.writeBinaryFile({
      path: join(workspace, "bin.dat"),
      content: new Uint8Array([1, 2, 3]),
    });
    await expect(
      session.readBinaryFile({ path: join(workspace, "bin.dat") })
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    await expect(
      session.readTextFile({ path: join(workspace, "nope.ts") })
    ).resolves.toBeNull();
    await session.stop();
  });

  it("refuses to read or write outside them, including through a symlink", async () => {
    const sup = supervisor();
    const { session } = await buildSession("confined", sup);
    await symlink(outside, join(workspace, "escape")).catch(() => {});

    await expect(
      session.readTextFile({ path: join(outside, "secret.txt") })
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.readTextFile({ path: join(workspace, "escape", "secret.txt") })
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.writeTextFile({
        path: join(workspace, "escape", "planted.txt"),
        content: "x",
      })
    ).rejects.toThrow(/outside every directory/);
    await session.stop();
  });

  it("answers the adapter's $HOME probe with the synthetic home", async () => {
    const sup = supervisor();
    const { session, sessionStateDir } = await buildSession("home", sup);
    const result = await session.run({ command: 'printf "%s" "$HOME"' });
    expect(result).toEqual({
      exitCode: 0,
      stdout: join(sessionStateDir, "home"),
      stderr: "",
    });
    expect(result.stdout).not.toBe(base);
    await session.stop();
  });

  it("satisfies the adapter's package-manager bootstrap without running one", async () => {
    const sup = supervisor();
    const { session } = await buildSession("bootstrap", sup);
    for (const command of [
      "mkdir -p /tmp/harness/claude-code",
      "pnpm --dir /tmp/harness/claude-code install --frozen-lockfile " +
        "--store-dir /tmp/harness/claude-code/.pnpm-store",
      "cd /tmp/harness/claude-code && if [ -f node_modules/@anthropic-ai/claude-code/install.cjs ]; " +
        "then node node_modules/@anthropic-ai/claude-code/install.cjs; fi && " +
        "./node_modules/.bin/claude --version",
    ]) {
      await expect(session.run({ command })).resolves.toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    }
    // Nothing was created at the adapter's hardcoded /tmp path.
    await expect(readFile("/tmp/harness/claude-code/package.json")).rejects.toThrow();
    await session.stop();
  });

  it("confines the bridge's OWN path arguments, not just our file calls", async () => {
    // These are consumed by the child, so nothing downstream would check them
    // if the translator did not: a `--workdir` pointed through a symlink out
    // of the workspace would start the agent outside its grant.
    const sup = supervisor();
    const { session } = await buildSession("bridge-args", sup);
    await symlink(outside, join(workspace, "escape-args")).catch(() => {});
    await expect(
      session.spawn({
        command:
          "node /tmp/harness/claude-code/bridge.mjs --workdir " +
          join(workspace, "escape-args", "work"),
      })
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.spawn({
        command: "node /tmp/harness/claude-code/bridge.mjs --workdir /etc",
      })
    ).rejects.toThrow(/outside every directory/);
    await session.stop();
  });

  it("refuses a command outside the pinned grammar instead of shelling out", async () => {
    const sup = supervisor();
    const { session } = await buildSession("grammar", sup);
    await expect(session.run({ command: "id > /tmp/pwned" })).rejects.toThrow(
      /never falls back to a shell/
    );
    await session.stop();
  });

  it("resolves a port only on loopback, and only one it leased", async () => {
    const sup = supervisor();
    const { session } = await buildSession("ports", sup);
    await expect(session.getPortUrl({ port: 39271, protocol: "ws" })).resolves.toBe(
      "ws://127.0.0.1:39271"
    );
    await expect(session.getPortUrl({ port: 22 })).rejects.toThrow(/not leased/);
    await session.stop();
  });
});

describe.skipIf(!canOwnProcesses)("the bridge launch", () => {
  it("runs the verified bundle with a sanitized environment, and cleans up", async () => {
    const sup = supervisor();
    const started: Array<{ pid: number; port: number }> = [];
    const { session, sessionStateDir } = await buildSession(
      "bridge",
      sup,
      async (a) => {
        started.push(a);
      }
    );

    const workDir = join(workspace, "claude-code-bridge");
    const bridgeStateDir = join(workspace, ".agent-runs", "bridge", "bridge");
    await session.run({ command: `mkdir -p ${workDir} ${bridgeStateDir}` });

    const proc = await session.spawn({
      command:
        `node /tmp/harness/claude-code/bridge.mjs --workdir ${workDir} ` +
        `--bridge-state-dir ${bridgeStateDir}`,
    });

    const line = await new Promise<string>((resolve) => {
      const reader = proc.stdout.getReader();
      void reader.read().then(({ value }) => {
        resolve(new TextDecoder().decode(value ?? new Uint8Array()));
        reader.releaseLock();
      });
    });
    const observed = JSON.parse(line.trim());

    // Launched from the digest-verified bundle, not the adapter's /tmp path.
    expect(observed.args).toEqual([
      "--workdir",
      workDir,
      "--bridge-state-dir",
      bridgeStateDir,
    ]);
    // Synthetic home, not the user's.
    expect(observed.home).toBe(join(sessionStateDir, "home"));
    // The scoped gateway endpoint reached the child; nothing else did.
    expect(observed.gateway).toBe("http://127.0.0.1:39400/gateway");
    expect(observed.cwd).toBe(workspace);

    // It is the session ROOT, so it is durably recorded for the janitor.
    const record = (await listProcessRecords()).find((r) => r.sessionId === "bridge");
    expect(record?.rootPid).toBe(proc.pid);
    expect(started).toEqual([{ pid: proc.pid!, port: 39271 }]);

    await session.stop();
    expect(await readProcessBirthIdentity(proc.pid!)).toBeNull();
    expect(
      (await listProcessRecords()).find((r) => r.sessionId === "bridge")
    ).toBeUndefined();
  }, 30_000);

  it("destroy also takes the tree down", async () => {
    const sup = supervisor();
    const { session } = await buildSession("destroy", sup);
    const proc = await session.spawn({
      command: `node /tmp/harness/claude-code/bridge.mjs --workdir ${workspace}`,
    });
    await session.destroy!();
    expect(await readProcessBirthIdentity(proc.pid!)).toBeNull();
  }, 30_000);
});
