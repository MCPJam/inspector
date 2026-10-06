/**
 * Supportability and enterprise (PR 6): pre-provisioning with no network,
 * installs through a proxy, `harness doctor` (and its redacted export), and
 * `harness repair`.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { create as createTar } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as packDigests from "../pack-digests.generated.js";
import {
  installRuntimePack,
  noteRuntimeLaunch,
  packPlatformKey,
  readRuntimeInstallStatus,
  repairRuntime,
  resetRuntimeInstallStateForTests,
  setPackSigningKeysForTests,
  type RuntimeInstallStatus,
} from "../runtime-install.js";
import { packAssetStem } from "../pack-naming.js";
import { computeTreeDigest } from "../runtime-identity.js";
import { setRuntimeProbeForTests } from "../runtime-probe.js";
import { setRuntimeMetricsSinkForTests } from "../runtime-metrics.js";
import { LAUNCH_FAILURE_THRESHOLD } from "../runtime-health.js";
import { buildDoctorReport, redactDoctorReport, renderDoctorReport, suggestRepairs } from "../runtime-doctor.js";
import { describeInstallerNetwork, installerFetch, redactProxyUrl } from "../runtime-fetch.js";
import { localPackTarget } from "../targets.js";

const TARGET = localPackTarget()!;
const VERSION = "2.0.0";
const keys = generateKeyPairSync("ed25519");
const testKey = { keyId: "test", publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() };

let base: string;
let runtimeRoot: string;
let release: string; // a directory holding a release's three files
let digest: string;
let probeOk = true;

/** A release as IT would download it: archive, signed manifest, signature. */
async function buildRelease(): Promise<void> {
  const staging = await mkdtemp(join(base, "stage-"));
  const root = join(staging, "claude-code");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin", "node"), 0o755);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pack", version: VERSION }));
  digest = await computeTreeDigest(root);
  release = join(base, "release");
  await mkdir(release, { recursive: true });
  const stem = packAssetStem("claude-code", packPlatformKey(), VERSION);
  const archive = join(release, `${stem}.tar.gz`);
  await createTar({ file: archive, gzip: true, cwd: resolve(staging), portable: false }, ["claude-code"]);
  const manifest = Buffer.from(
    JSON.stringify({
      schema: "mcpjam.local-harness-pack/1",
      harnessId: "claude-code",
      packVersion: VERSION,
      adapterVersion: "test",
      platform: packPlatformKey(),
      nodeVersion: "24",
      treeDigest: digest,
      files: 2,
      bytes: 1024,
      archive: { name: `${stem}.tar.gz`, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex") },
    }),
  );
  await writeFile(join(release, `${stem}.manifest.json`), manifest);
  await writeFile(join(release, `${stem}.manifest.json.sig`), sign(null, manifest, keys.privateKey).toString("base64"));
  await rm(staging, { recursive: true, force: true });
}

const archivePath = () => join(release, `${packAssetStem("claude-code", packPlatformKey(), VERSION)}.tar.gz`);

function pin(treeDigest = digest): void {
  vi.spyOn(packDigests, "PACK_RECORDS", "get").mockReturnValue({
    "claude-code": { [TARGET]: { packVersion: VERSION, treeDigest } },
    codex: {},
  } as typeof packDigests.PACK_RECORDS);
  vi.spyOn(packDigests, "PERMITTED_PACK_RECORDS", "get").mockReturnValue({ "claude-code": {}, codex: {} } as typeof packDigests.PERMITTED_PACK_RECORDS);
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-support-")));
  await buildRelease();
  setPackSigningKeysForTests([testKey]);
  setRuntimeProbeForTests(async () => (probeOk ? { ok: true, node: "v24", vendorVersion: "2" } : { ok: false, message: "no" }));
  setRuntimeMetricsSinkForTests(() => {});
});

beforeEach(() => {
  runtimeRoot = join(base, `runtime-${Math.random().toString(36).slice(2)}`);
  process.env.MCPJAM_RUNTIME_ROOT = runtimeRoot;
  delete process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  probeOk = true;
  pin();
});

afterEach(async () => {
  resetRuntimeInstallStateForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await new Promise((r) => setTimeout(r, 20));
  await rm(runtimeRoot, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.MCPJAM_RUNTIME_ROOT;
  setPackSigningKeysForTests(null);
  setRuntimeProbeForTests(null);
  setRuntimeMetricsSinkForTests(null);
  await rm(base, { recursive: true, force: true });
});

describe("pre-provisioning: harness install --from <archive>", () => {
  it("installs with no network at all, through every check a download gets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no network on this machine");
    }));
    const result = await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
    expect(result).toMatchObject({ state: "ready", packVersion: VERSION, digest });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("works under an administrator's manual update policy", async () => {
    const config = join(base, "managed.json");
    await writeFile(config, JSON.stringify({ localHarness: { updates: "manual" } }));
    process.env.MCPJAM_MANAGED_CONFIG = config;
    try {
      expect((await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() })).state).toBe("ready");
    } finally {
      delete process.env.MCPJAM_MANAGED_CONFIG;
    }
  });

  it("refuses an archive without its signed manifest — unlike the development override", async () => {
    const lonely = join(base, "lonely");
    await mkdir(lonely, { recursive: true });
    const copy = join(lonely, "pack.tar.gz");
    await writeFile(copy, readFileSync(archivePath()));
    const result = await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: copy });
    expect(result).toMatchObject({ state: "failed", stage: "verify" });
    expect(result.state === "failed" && result.message).toMatch(/cannot be shown to have come from MCPJam/);
  });

  it("refuses a signed archive that is not the pack this build pins", async () => {
    pin(`sha256:${"0".repeat(64)}`);
    const result = await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
    expect(result).toMatchObject({ state: "failed" });
    expect(result.state === "failed" && result.message).toMatch(/does not match/);
  });

  it("refuses a manifest signed by somebody else", async () => {
    setPackSigningKeysForTests([{ keyId: "other", publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString() }]);
    try {
      const result = await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
      expect(result).toMatchObject({ state: "failed", stage: "verify", reason: "verification" });
    } finally {
      setPackSigningKeysForTests([testKey]);
    }
  });
});

describe("installing behind a proxy", () => {
  let proxy: Server;
  let proxied: string[];
  const saved: Record<string, string | undefined> = {};
  let origin: Server;
  beforeAll(async () => {
    proxied = [];
    // The only server that can answer: whatever host a request names, the
    // proxy tunnels it here.
    origin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("via proxy");
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
    // A CONNECT proxy, as corporate proxies are: it records the target each
    // tunnel was opened for and splices it to the origin above.
    proxy = createServer((_req, res) => res.writeHead(405).end());
    proxy.on("connect", (req, clientSocket: import("node:net").Socket, head: Buffer) => {
      proxied.push(req.url ?? "");
      const upstream = connect((origin.address() as { port: number }).port, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  });
  afterAll(async () => {
    proxy.closeAllConnections?.();
    origin.closeAllConnections?.();
    await new Promise((r) => proxy.close(() => r(undefined)));
    await new Promise((r) => origin.close(() => r(undefined)));
  });
  beforeEach(() => {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("sends installer requests through HTTP(S)_PROXY", async () => {
    const port = (proxy.address() as { port: number }).port;
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
    const response = await installerFetch("http://packs.example.test/manifest.json", { signal: AbortSignal.timeout(10_000) });
    expect(await response.text()).toBe("via proxy");
    expect(proxied).toContain("packs.example.test:80");
  });

  it("honours NO_PROXY", async () => {
    const port = (proxy.address() as { port: number }).port;
    const direct = createServer((_req, res) => res.end("direct"));
    await new Promise<void>((r) => direct.listen(0, "127.0.0.1", () => r()));
    try {
      process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
      process.env.NO_PROXY = "127.0.0.1";
      const before = proxied.length;
      const response = await installerFetch(`http://127.0.0.1:${(direct.address() as { port: number }).port}/x`);
      expect(await response.text()).toBe("direct");
      expect(proxied.length).toBe(before);
    } finally {
      direct.closeAllConnections?.();
      await new Promise((r) => direct.close(() => r(undefined)));
    }
  });

  it("reports the proxy and CA settings without the proxy's credentials", () => {
    expect(redactProxyUrl("http://alice:s3cret@proxy.corp:3128")).toBe("http://***@proxy.corp:3128");
    expect(
      describeInstallerNetwork({ HTTPS_PROXY: "http://alice:s3cret@proxy.corp:3128", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem" }),
    ).toEqual({ proxy: "http://***@proxy.corp:3128", noProxy: "localhost", extraCaCerts: "/etc/ssl/corp.pem" });
  });
});

describe("harness doctor", () => {
  it("reports what runs, what is installed, and the repair to run", async () => {
    let report = await buildDoctorReport({ harnessIds: ["claude-code"] });
    expect(report.harnesses[0]).toMatchObject({
      harnessId: "claude-code",
      selected: { state: "absent" },
      desired: { packVersion: VERSION, installed: false, health: "absent" },
      repairs: [expect.stringMatching(/harness install/)],
    });
    await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
    report = await buildDoctorReport({ harnessIds: ["claude-code"], verify: true });
    expect(report.harnesses[0]).toMatchObject({
      selected: { state: "ready", role: "desired" },
      desired: { installed: true, health: "healthy" },
      lastAttempt: { state: "ready", trigger: "provision" },
      repairs: [],
    });
    expect(report.runtimeRoot).toBe(runtimeRoot);
    expect(renderDoctorReport(report)).toMatch(/runs: 2\.0\.0 \(desired\)/);
  });

  it("names the failing stage and the network advice after a download failure", () => {
    const repairs = suggestRepairs({
      harnessId: "codex",
      selected: { state: "absent", packVersion: VERSION },
      desiredStatus: { state: "failed", packVersion: VERSION, reason: "network", stage: "download", message: "fetch failed" },
      desired: { packVersion: VERSION, treeDigest: digest, installed: false, revoked: null, health: "absent" },
      policy: "auto",
      proxyConfigured: false,
    });
    expect(repairs[0]).toMatch(/HTTPS_PROXY/);
    expect(repairs).toContain("mcpjam-inspector harness install --harness codex");
    expect(repairs.some((r) => r.includes("--from"))).toBe(true);
  });

  it("exports with no home path, proxy credential or token in it", async () => {
    const report = await buildDoctorReport({ harnessIds: ["claude-code"] });
    const leaky = {
      ...report,
      runtimeRoot: join(homedir(), ".mcpjam", "runtime"),
      network: { proxy: "http://alice:s3cret@proxy.corp:3128", noProxy: null, extraCaCerts: join(homedir(), "corp.pem") },
      harnesses: report.harnesses.map((h) => ({
        ...h,
        desiredStatus: {
          state: "failed",
          packVersion: VERSION,
          reason: "network",
          message: `GET https://x.test/?token=abc123def456 failed with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U at ${homedir()}/x; ghp_${"a".repeat(36)} sk-${"b".repeat(32)}`,
        } as RuntimeInstallStatus,
      })),
    };
    const text = JSON.stringify(redactDoctorReport(leaky));
    expect(text).not.toContain(homedir());
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("eyJhbGci");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("sk-bbbb");
    expect(text).toContain("~/.mcpjam/runtime");
  });
});

describe("harness repair", () => {
  it("reinstalls a pack whose bytes changed", async () => {
    await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
    const packageJson = join(runtimeRoot, TARGET, VERSION, "claude-code", "package.json");
    await writeFile(packageJson, "tampered");
    const { status, actions } = await repairRuntime({ harnessId: "claude-code", fromArchive: archivePath() });
    expect(status).toMatchObject({ state: "ready", packVersion: VERSION });
    expect(actions.join("\n")).toMatch(/does not verify; reinstalling/);
    expect(readFileSync(packageJson, "utf8")).toContain(VERSION);
  });

  it("re-probes an unhealthy pack and clears the mark when it now starts", async () => {
    await installRuntimePack({ harnessId: "claude-code", trigger: "provision", fromArchive: archivePath() });
    const ready = (await readRuntimeInstallStatus({ harnessId: "claude-code" })) as Extract<RuntimeInstallStatus, { state: "ready" }>;
    for (let i = 0; i < LAUNCH_FAILURE_THRESHOLD; i += 1) {
      await noteRuntimeLaunch({ harnessId: "claude-code", status: ready, outcome: { ok: false, reason: "x" } });
    }
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code" })).toMatchObject({ health: "unhealthy" });
    probeOk = false;
    expect((await repairRuntime({ harnessId: "claude-code" })).status).toMatchObject({ state: "failed", stage: "probe" });
    probeOk = true;
    const repaired = await repairRuntime({ harnessId: "claude-code" });
    expect(repaired.actions.join("\n")).toMatch(/cleared its unhealthy mark/);
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code" })).not.toMatchObject({ health: "unhealthy" });
  });

  it("clears provably abandoned staging", async () => {
    const installRoot = join(runtimeRoot, TARGET);
    const staging = join(installRoot, ".mcpjam-tmp-dead");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ".mcpjam-staging-owner.json"), JSON.stringify({ pid: 2 ** 22 + 9, startedAt: 1, attemptId: "att_x", at: 1 }));
    const { actions } = await repairRuntime({ harnessId: "claude-code", fromArchive: archivePath() });
    expect(actions[0]).toMatch(/abandoned staging/);
    await expect(stat(staging)).rejects.toThrow();
    expect((await readdir(installRoot)).filter((n) => n.startsWith(".mcpjam-tmp-"))).toEqual([]);
  });
});
