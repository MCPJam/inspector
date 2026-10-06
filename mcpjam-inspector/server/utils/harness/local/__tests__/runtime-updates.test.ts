/**
 * Dependable updates, on the failure paths — PR 5's acceptance tests.
 *
 * The promise: routine updates keep a working installation, and failures
 * recover without an engineer. So every case here starts from a machine with
 * a working runtime (the permitted previous pack, installed) and breaks the
 * update in one specific way — a candidate that cannot start, a full disk, a
 * download that dies, a pack MCPJam withdrew, a bad pack that only fails once
 * users run it — and asserts the same three things each time:
 *
 *   1. the previous runtime stays selected and usable;
 *   2. the broken candidate is never selected;
 *   3. the next attempt (or the rollback) needs no engineer.
 *
 * Real archives, real extraction, real digests, real lifecycle locks; only
 * the startup probe (fixture packs carry no real Node) and the disk-free
 * reading are seams, and both have their own tests.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create as createTar } from "tar";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as packDigests from "../pack-digests.generated.js";
import {
  installRuntimePack,
  noteRuntimeLaunch,
  packPlatformKey,
  readDesiredRuntimeStatus,
  readRuntimeInstallStatus,
  resetRuntimeInstallStateForTests,
  setFreeSpaceProbeForTests,
  startRuntimeInstall,
  type RuntimeInstallStatus,
} from "../runtime-install.js";
import { computeTreeDigest, predictManagedRuntimeId } from "../runtime-identity.js";
import { setRuntimeProbeForTests } from "../runtime-probe.js";
import { setRuntimeMetricsSinkForTests } from "../runtime-metrics.js";
import { REVOCATION_SCHEMA, refreshRevocations, resetRevocationRefreshForTests, setRevocationKeysForTests } from "../runtime-revocation.js";
import { LAUNCH_FAILURE_THRESHOLD } from "../runtime-health.js";
import { collectRuntimeGarbage, writeLivenessRecord } from "../runtime-gc.js";
import { PREVIOUS_SUFFIX, reserveRuntimeUse } from "../runtime-lifecycle.js";
import { LOCAL_HARNESS_MANIFEST } from "../compatibility.js";
import { currentLocalPlatform, localPackTarget } from "../targets.js";

const TARGET = localPackTarget()!;
const PLATFORM = currentLocalPlatform(process.platform)!;
const OLD = "1.0.0";
const NEW = "1.0.1";

let base: string;
let runtimeRoot: string;
const archives: Record<string, string> = {};
const digests: Record<string, string> = {};
const events: Array<{ event: string; props: Record<string, unknown> }> = [];
let probeResult: { ok: true; node: string; vendorVersion: string } | { ok: false; message: string };
let freeBytes: number | null;

/** A real Ed25519 key standing in for MCPJam's, so revocation lists can be signed. */
const keys = generateKeyPairSync("ed25519");
const testKey = {
  keyId: "test",
  publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
};

/** Archive a miniature, structurally real Claude Code pack. */
async function buildPack(version: string): Promise<void> {
  const staging = await mkdtemp(join(base, `stage-${version}-`));
  const root = join(staging, "claude-code");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(join(root, "bin", "node"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "bin", "node"), 0o755);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pack", version }));
  digests[version] = await computeTreeDigest(root);
  archives[version] = join(base, `pack-${version}.tar.gz`);
  await createTar({ file: archives[version], gzip: true, cwd: resolve(staging), portable: false }, ["claude-code"]);
  await rm(staging, { recursive: true, force: true });
}

/** What this build pins: desired, and optionally a permitted previous. */
function pin(desired: string, permitted?: string): void {
  const ref = (version: string) => ({ packVersion: version, treeDigest: digests[version]! });
  vi.spyOn(packDigests, "PACK_RECORDS", "get").mockReturnValue({
    "claude-code": { [TARGET]: ref(desired) },
    codex: {},
  } as typeof packDigests.PACK_RECORDS);
  vi.spyOn(packDigests, "PERMITTED_PACK_RECORDS", "get").mockReturnValue({
    "claude-code": permitted ? { [TARGET]: ref(permitted) } : {},
    codex: {},
  } as typeof packDigests.PERMITTED_PACK_RECORDS);
}

/** Serve `version`'s archive as the download. */
function serve(version: string | null): void {
  process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE = version === null ? join(base, "missing.tar.gz") : archives[version]!;
}

/** A machine that already runs `OLD`, with this build now desiring `NEW`. */
async function machineOnOldPackWithUpdatePinned(): Promise<void> {
  pin(OLD);
  serve(OLD);
  expect((await installRuntimePack({ harnessId: "claude-code", trigger: "cli" })).state).toBe("ready");
  pin(NEW, OLD);
}

async function selected(): Promise<RuntimeInstallStatus> {
  return readRuntimeInstallStatus({ harnessId: "claude-code" });
}

async function publishRevocations(sequence: number, revoked: Array<{ treeDigest: string; reason: string }>): Promise<void> {
  const list = Buffer.from(
    JSON.stringify({
      schema: REVOCATION_SCHEMA,
      sequence,
      issuedAt: new Date().toISOString(),
      revoked: revoked.map((entry) => ({ harnessId: "claude-code", ...entry })),
    }),
  );
  const signature = sign(null, list, keys.privateKey).toString("base64");
  const fetchImpl = (async (url: string) =>
    new Response(url.endsWith(".sig") ? signature : list)) as unknown as typeof fetch;
  const result = await refreshRevocations({ force: true, fetchImpl, url: "https://revocations.test/list.json" });
  expect(result.state).toBe("updated");
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-updates-")));
  await buildPack(OLD);
  await buildPack(NEW);
  setRuntimeProbeForTests(async () => probeResult);
  setFreeSpaceProbeForTests(async () => freeBytes);
  setRuntimeMetricsSinkForTests((event, props) => events.push({ event, props }));
  setRevocationKeysForTests([testKey]);
});

beforeEach(async () => {
  runtimeRoot = join(base, `runtime-${Math.random().toString(36).slice(2)}`);
  process.env.MCPJAM_RUNTIME_ROOT = runtimeRoot;
  probeResult = { ok: true, node: "v24.0.0", vendorVersion: "2.0.0" };
  freeBytes = null;
  events.length = 0;
  resetRevocationRefreshForTests();
});

afterEach(async () => {
  resetRuntimeInstallStateForTests();
  vi.restoreAllMocks();
  // Give a post-activation GC (fire-and-forget) a moment before removing its root.
  await new Promise((r) => setTimeout(r, 20));
  await rm(runtimeRoot, { recursive: true, force: true });
});

afterAll(async () => {
  delete process.env.MCPJAM_RUNTIME_ROOT;
  delete process.env.MCPJAM_LOCAL_HARNESS_PACK_SOURCE;
  setRuntimeProbeForTests(null);
  setFreeSpaceProbeForTests(null);
  setRuntimeMetricsSinkForTests(null);
  setRevocationKeysForTests(null);
  await rm(base, { recursive: true, force: true });
});

describe("per-build selection", () => {
  it("runs the permitted previous pack while the desired one is not installed — and says an update is pending", async () => {
    await machineOnOldPackWithUpdatePinned();
    const status = await selected();
    expect(status).toMatchObject({ state: "ready", role: "permitted", packVersion: OLD, digest: digests[OLD] });
    if (status.state !== "ready") throw new Error("unreachable");
    expect(status.update).toMatchObject({ state: "absent", packVersion: NEW });
  });

  it("switches to the desired pack once it is installed, and the old one stays on disk for the previous build", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" })).state).toBe("ready");
    expect(await selected()).toMatchObject({ state: "ready", role: "desired", packVersion: NEW });
    // The permitted pack is still this build's fallback, so GC keeps it.
    await collectRuntimeGarbage();
    expect((await readdir(join(runtimeRoot, TARGET))).filter((name) => !name.startsWith("."))).toEqual(
      expect.arrayContaining([OLD, NEW]),
    );
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["local_runtime_install_started", "local_runtime_install_succeeded", "local_runtime_update_activated"]),
    );
  });

  it("keeps a turn on the runtime its grant names while that runtime is still selectable", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    const manifest = LOCAL_HARNESS_MANIFEST["claude-code"];
    const oldRuntimeId = predictManagedRuntimeId(manifest, PLATFORM, digests[OLD]!);
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code", preferRuntimeId: oldRuntimeId })).toMatchObject({
      role: "permitted",
      packVersion: OLD,
    });
    // A grant naming nothing selectable does not pin anything.
    expect(await readRuntimeInstallStatus({ harnessId: "claude-code", preferRuntimeId: "rt_gone" })).toMatchObject({
      role: "desired",
    });
  });
});

describe("install and update failures leave the working runtime usable", () => {
  it("a candidate that fails its startup probe is never activated, and never selected", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    probeResult = { ok: false, message: "the Inspector layer did not start on the candidate pack" };
    const result = await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    expect(result).toMatchObject({ state: "failed", stage: "probe", reason: "probe" });
    await expect(stat(join(runtimeRoot, TARGET, NEW))).rejects.toThrow();
    expect(await selected()).toMatchObject({ role: "permitted", packVersion: OLD });
    const names = events.map((e) => e.event);
    expect(names).toContain("local_runtime_candidate_probe_failed");
    expect(events.find((e) => e.event === "local_runtime_install_failed")?.props).toMatchObject({ stage: "probe" });
  });

  it("a background retry backs off after a failed probe; an explicit retry does not", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    probeResult = { ok: false, message: "no" };
    await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    probeResult = { ok: true, node: "v24.0.0", vendorVersion: "2.0.0" };
    expect(await startRuntimeInstall({ harnessId: "claude-code", trigger: "boot" })).toMatchObject({
      kind: "refused",
      refusal: "backoff",
    });
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" })).state).toBe("ready");
    expect(await selected()).toMatchObject({ role: "desired", packVersion: NEW });
  });

  it("an exhausted disk fails at stage disk-space before a byte is downloaded", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    freeBytes = 1024;
    const result = await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    expect(result).toMatchObject({ state: "failed", stage: "disk-space", reason: "disk" });
    expect(result.state === "failed" && result.message).toMatch(/not enough free disk space/);
    expect(await selected()).toMatchObject({ role: "permitted", packVersion: OLD });
  });

  it("a download that fails leaves the active runtime alone, and a clean retry follows", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(null);
    const failed = await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    expect(failed).toMatchObject({ state: "failed" });
    expect(await selected()).toMatchObject({ role: "permitted", packVersion: OLD });
    // No staging left to collide with the retry.
    const leftovers = (await readdir(join(runtimeRoot, TARGET))).filter((name) => name.startsWith(".mcpjam-tmp-"));
    expect(leftovers).toEqual([]);
    serve(NEW);
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" })).state).toBe("ready");
    expect(await selected()).toMatchObject({ role: "desired", packVersion: NEW });
  });

  it("a crash between activation's two renames is recovered, not re-downloaded", async () => {
    pin(OLD);
    serve(OLD);
    await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
    const versionRoot = join(runtimeRoot, TARGET, OLD);
    const { rename } = await import("node:fs/promises");
    await rename(versionRoot, `${versionRoot}${PREVIOUS_SUFFIX}`);
    expect(await selected()).toMatchObject({ state: "ready", packVersion: OLD });
    await expect(stat(`${versionRoot}${PREVIOUS_SUFFIX}`)).rejects.toThrow();
  });
});

describe("rollback after a bad activation", () => {
  it("repeated launch failures on the new pack fall back to the previous one — and replay nothing", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    const onNew = await selected();
    if (onNew.state !== "ready") throw new Error("expected ready");
    expect(onNew.role).toBe("desired");

    for (let i = 0; i < LAUNCH_FAILURE_THRESHOLD; i += 1) {
      await noteRuntimeLaunch({ harnessId: "claude-code", status: onNew, outcome: { ok: false, reason: "readiness: bridge exited" } });
    }
    const after = await selected();
    expect(after).toMatchObject({ state: "ready", role: "permitted", packVersion: OLD });
    if (after.state !== "ready") throw new Error("unreachable");
    expect(after.update).toMatchObject({ state: "ready", packVersion: NEW, health: "unhealthy" });
    const names = events.map((e) => e.event);
    expect(names.filter((name) => name === "local_runtime_launch_failed_after_update")).toHaveLength(LAUNCH_FAILURE_THRESHOLD);
    expect(names).toContain("local_runtime_rolled_back_to_previous");
  });

  it("a success between failures resets the count", async () => {
    await machineOnOldPackWithUpdatePinned();
    serve(NEW);
    await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    const onNew = (await selected()) as Extract<RuntimeInstallStatus, { state: "ready" }>;
    for (let i = 0; i < LAUNCH_FAILURE_THRESHOLD - 1; i += 1) {
      await noteRuntimeLaunch({ harnessId: "claude-code", status: onNew, outcome: { ok: false, reason: "x" } });
    }
    await noteRuntimeLaunch({ harnessId: "claude-code", status: onNew, outcome: { ok: true } });
    await noteRuntimeLaunch({ harnessId: "claude-code", status: onNew, outcome: { ok: false, reason: "x" } });
    expect(await selected()).toMatchObject({ role: "desired", packVersion: NEW });
    expect(events.find((e) => e.event === "local_runtime_time_to_first_usable_turn")).toBeDefined();
  });

  it("an unhealthy pack with nothing to fall back to stays selectable, marked degraded", async () => {
    pin(NEW);
    serve(NEW);
    await installRuntimePack({ harnessId: "claude-code", trigger: "gesture" });
    const onNew = (await selected()) as Extract<RuntimeInstallStatus, { state: "ready" }>;
    for (let i = 0; i < LAUNCH_FAILURE_THRESHOLD; i += 1) {
      await noteRuntimeLaunch({ harnessId: "claude-code", status: onNew, outcome: { ok: false, reason: "x" } });
    }
    expect(await selected()).toMatchObject({ state: "ready", role: "desired", health: "unhealthy" });
  });
});

describe("revocation", () => {
  it("never downloads or selects a revoked desired pack; the permitted one carries on", async () => {
    await machineOnOldPackWithUpdatePinned();
    await publishRevocations(1, [{ treeDigest: digests[NEW]!, reason: "bad build" }]);
    serve(NEW);
    expect(await startRuntimeInstall({ harnessId: "claude-code", trigger: "gesture" })).toMatchObject({
      kind: "refused",
      refusal: "revoked",
    });
    const status = await selected();
    expect(status).toMatchObject({ role: "permitted", packVersion: OLD });
    if (status.state !== "ready") throw new Error("unreachable");
    expect(status.update).toMatchObject({ state: "revoked" });
  });

  it("never selects a revoked pack as a fallback either — launch fails closed with MCPJam's reason", async () => {
    await machineOnOldPackWithUpdatePinned();
    await publishRevocations(1, [
      { treeDigest: digests[NEW]!, reason: "bad build" },
      { treeDigest: digests[OLD]!, reason: "security fix" },
    ]);
    const status = await selected();
    expect(status).toMatchObject({ state: "revoked", packVersion: NEW });
    expect(status.state === "revoked" && status.message).toMatch(/withdrew/);
  });

  it("refuses an older list than the one cached, so a replay cannot un-revoke a pack", async () => {
    await machineOnOldPackWithUpdatePinned();
    await publishRevocations(5, [{ treeDigest: digests[OLD]!, reason: "x" }]);
    const list = Buffer.from(JSON.stringify({ schema: REVOCATION_SCHEMA, sequence: 4, issuedAt: "2026-01-01T00:00:00Z", revoked: [] }));
    const signature = sign(null, list, keys.privateKey).toString("base64");
    const replay = await refreshRevocations({
      force: true,
      url: "https://revocations.test/list.json",
      fetchImpl: (async (url: string) => new Response(url.endsWith(".sig") ? signature : list)) as unknown as typeof fetch,
    });
    expect(replay).toMatchObject({ state: "failed", message: expect.stringMatching(/already cached/) });
    expect(await selected()).not.toMatchObject({ state: "ready", packVersion: OLD });
  });

  it("ignores a list that is not signed by a trusted key", async () => {
    await machineOnOldPackWithUpdatePinned();
    const forged = generateKeyPairSync("ed25519");
    const list = Buffer.from(
      JSON.stringify({ schema: REVOCATION_SCHEMA, sequence: 1, issuedAt: "2026-01-01T00:00:00Z", revoked: [{ harnessId: "claude-code", treeDigest: digests[OLD], reason: "forged" }] }),
    );
    const signature = sign(null, list, forged.privateKey).toString("base64");
    const result = await refreshRevocations({
      force: true,
      url: "https://revocations.test/list.json",
      fetchImpl: (async (url: string) => new Response(url.endsWith(".sig") ? signature : list)) as unknown as typeof fetch,
    });
    expect(result.state).toBe("failed");
    expect(await selected()).toMatchObject({ state: "ready", packVersion: OLD });
  });
});

describe("the update policy", () => {
  let config: string;
  beforeEach(async () => {
    config = join(base, `managed-${Math.random().toString(36).slice(2)}.json`);
    process.env.MCPJAM_MANAGED_CONFIG = config;
  });
  afterEach(() => {
    delete process.env.MCPJAM_MANAGED_CONFIG;
  });

  it("under manual, refuses the gesture and background triggers, and lets harness install through", async () => {
    await writeFile(config, JSON.stringify({ localHarness: { updates: "manual" } }));
    pin(NEW);
    serve(NEW);
    for (const trigger of ["gesture", "boot", "readiness"] as const) {
      expect(await startRuntimeInstall({ harnessId: "claude-code", trigger })).toMatchObject({ kind: "refused", refusal: "policy" });
    }
    expect((await installRuntimePack({ harnessId: "claude-code", trigger: "cli" })).state).toBe("ready");
  });

  it("treats an unreadable policy file as manual rather than fetching against it", async () => {
    await writeFile(config, "{ not json");
    pin(NEW);
    serve(NEW);
    expect(await startRuntimeInstall({ harnessId: "claude-code", trigger: "boot" })).toMatchObject({ refusal: "policy" });
  });
});

describe("cleanup", () => {
  /** A second Inspector process that names `digest` in its liveness record. */
  async function anotherInspectorSelecting(digest: string) {
    const liveness = join(runtimeRoot, ".mcpjam-liveness");
    await mkdir(liveness, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { writeFileSync } from "node:fs";
         const startedAt = Math.floor((Date.now() - process.uptime() * 1000) / 1000);
         writeFileSync(${JSON.stringify(liveness)} + "/" + process.pid + "-" + startedAt + ".json",
           JSON.stringify({ pid: process.pid, startedAt, updatedAt: Date.now(), target: ${JSON.stringify(TARGET)},
             packs: { "claude-code": [${JSON.stringify(digest)}] }, layers: [] }));
         console.log("READY");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolveReady) => child.stdout!.once("data", () => resolveReady()));
    return child;
  }

  it("two Inspector versions on one root: GC deletes neither one's packs, and reclaims the old one once its owner is gone", async () => {
    // This build desires only NEW (no permitted pack); another live Inspector
    // still desires OLD.
    pin(OLD);
    serve(OLD);
    await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
    const other = await anotherInspectorSelecting(digests[OLD]!);
    try {
      // This build updates to NEW while the other one is running on OLD: the
      // GC that follows the activation must leave OLD alone.
      pin(NEW);
      serve(NEW);
      await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
      await writeLivenessRecord();
      const report = await collectRuntimeGarbage();
      expect(report.removedVersions).toEqual([]);
      await expect(stat(join(runtimeRoot, TARGET, OLD))).resolves.toBeDefined();
    } finally {
      other.kill("SIGKILL");
      await new Promise((r) => other.once("exit", r));
    }
    const report = await collectRuntimeGarbage();
    expect(report.removedVersions).toEqual([`claude-code/${TARGET}/${OLD}`]);
    await expect(stat(join(runtimeRoot, TARGET, NEW))).resolves.toBeDefined();
  });

  it("a session running during activation and GC keeps its tree", async () => {
    pin(OLD);
    serve(OLD);
    await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
    const versionRoot = join(runtimeRoot, TARGET, OLD);
    const held = await reserveRuntimeUse({
      key: { runtimeRoot, harnessId: "claude-code", target: TARGET, packVersion: OLD, treeDigest: digests[OLD]! },
      runtimeRoot: versionRoot,
      label: "session",
    });
    // The build moves on; nothing selects OLD any more but the session holds it.
    pin(NEW);
    serve(NEW);
    await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
    expect((await collectRuntimeGarbage()).removedVersions).toEqual([]);
    await expect(readFile(join(versionRoot, "claude-code", "package.json"), "utf8")).resolves.toContain(OLD);
    await held.release();
    expect((await collectRuntimeGarbage()).removedVersions).toEqual([`claude-code/${TARGET}/${OLD}`]);
  });

  it("reclaims an orphaned .mcpjam-previous beside a complete version, and ownerless staging", async () => {
    pin(OLD);
    serve(OLD);
    await installRuntimePack({ harnessId: "claude-code", trigger: "cli" });
    const installRoot = join(runtimeRoot, TARGET);
    await mkdir(join(installRoot, `${OLD}${PREVIOUS_SUFFIX}`, "claude-code"), { recursive: true });
    // A staging directory claimed by a process that is provably gone.
    const staging = join(installRoot, ".mcpjam-tmp-dead");
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, ".mcpjam-staging-owner.json"), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 1, attemptId: "att_dead", at: 1 }));
    const report = await collectRuntimeGarbage();
    await expect(stat(join(installRoot, `${OLD}${PREVIOUS_SUFFIX}`))).rejects.toThrow();
    await expect(stat(staging)).rejects.toThrow();
    expect(report.stagingRemoved).toBe(1);
    await expect(stat(join(installRoot, OLD))).resolves.toBeDefined();
  });
});

describe("the platform key the fixtures assume", () => {
  it("is this machine's", () => {
    expect(packPlatformKey()).toBe(TARGET);
    expect(readDesiredRuntimeStatus).toBeTypeOf("function");
  });
});
