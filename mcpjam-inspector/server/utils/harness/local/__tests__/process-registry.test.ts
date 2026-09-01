import { mkdtemp, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supportsOwnershipProof, readProcessBirthIdentity } from "../process-identity.js";
import {
  forgetProcess,
  listProcessRecords,
  mintSupervisorNonce,
  reclaimAbandonedProcesses,
  recordProcess,
  updateLifecycleState,
  type LocalHarnessProcessRecord,
} from "../process-registry.js";
import { LocalHarnessSupervisor } from "../supervisor.js";

const canOwnProcesses = supportsOwnershipProof();

let base: string;
let scripts: string;
const realHome = process.env.HOME;

function record(
  overrides: Partial<LocalHarnessProcessRecord> = {}
): LocalHarnessProcessRecord {
  return {
    sessionId: "s-x",
    supervisorNonce: "sup_dead",
    runtimeId: "rt_test",
    rootPid: 1,
    processBirthIdentity: "linux:0",
    startedAt: new Date().toISOString(),
    workspaceGrantId: "ws_test",
    targetKind: "local-native",
    lifecycleState: "running",
    sessionStateDir: join(base, ".mcpjam", "harness-local", "sessions", "s-x"),
    ...overrides,
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-registry-")));
  process.env.HOME = base;
  scripts = join(base, "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "idle.js"),
    "console.log('ready');setInterval(()=>{},1000);"
  );
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

beforeEach(async () => {
  for (const r of await listProcessRecords()) await forgetProcess(r.sessionId);
});

describe("the durable record", () => {
  it("round-trips and updates lifecycle state", async () => {
    await recordProcess(record({ sessionId: "s-round" }));
    await updateLifecycleState("s-round", "suspended");
    const stored = (await listProcessRecords()).find((r) => r.sessionId === "s-round");
    expect(stored?.lifecycleState).toBe("suspended");
  });

  it("replaces a record for the same session rather than accumulating", async () => {
    await recordProcess(record({ sessionId: "s-dup", rootPid: 10 }));
    await recordProcess(record({ sessionId: "s-dup", rootPid: 11 }));
    const stored = (await listProcessRecords()).filter((r) => r.sessionId === "s-dup");
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rootPid).toBe(11);
  });
});

describe("the janitor", () => {
  it("leaves the live supervisor's own sessions alone", async () => {
    const nonce = mintSupervisorNonce();
    await recordProcess(record({ sessionId: "s-mine", supervisorNonce: nonce }));
    const results = await reclaimAbandonedProcesses({ liveNonce: nonce });
    expect(results).toContainEqual({
      sessionId: "s-mine",
      outcome: "skipped-live-supervisor",
    });
    expect(await listProcessRecords()).toHaveLength(1);
  });

  it("drops a record whose process is simply gone, and cleans its state", async () => {
    const sessionStateDir = join(
      base,
      ".mcpjam",
      "harness-local",
      "sessions",
      "s-gone"
    );
    await mkdir(sessionStateDir, { recursive: true });
    await writeFile(join(sessionStateDir, "leftover"), "x");
    // A pid that has certainly exited: this test's own throwaway child.
    await recordProcess(
      record({
        sessionId: "s-gone",
        rootPid: 2_147_480_000,
        sessionStateDir,
      })
    );
    const results = await reclaimAbandonedProcesses({ liveNonce: "sup_live" });
    expect(results).toContainEqual({ sessionId: "s-gone", outcome: "already-gone" });
    expect(await listProcessRecords()).toHaveLength(0);
    await expect(readdir(sessionStateDir)).rejects.toThrow();
  });

  it.skipIf(!canOwnProcesses)(
    "REFUSES to kill a reused pid, and keeps the record so the mismatch stays visible",
    async () => {
      // The whole reason a birth identity exists. A live process with a
      // birth identity that does not match ours is somebody else's.
      const sup = new LocalHarnessSupervisor({
        limits: { terminationGraceMs: 300 },
      });
      const handle = await sup.spawnSupervised({
        sessionId: "s-live",
        executable: process.execPath,
        args: [join(scripts, "idle.js")],
        workingDirectory: base,
        env: { PATH: "/usr/bin:/bin" },
        runtimeId: "rt_test",
        workspaceGrantId: "ws_test",
        targetKind: "local-native",
        sessionStateDir: join(base, "state"),
        role: "root",
      });
      const realIdentity = await readProcessBirthIdentity(handle.pid);
      expect(realIdentity).not.toBeNull();

      // Same pid, a birth identity from a process that used to hold it.
      await forgetProcess("s-live");
      await recordProcess(
        record({
          sessionId: "s-reused",
          rootPid: handle.pid,
          processBirthIdentity: "linux:1",
        })
      );

      const results = await reclaimAbandonedProcesses({ liveNonce: "sup_live" });
      expect(results).toContainEqual({ sessionId: "s-reused", outcome: "not-owned" });
      // The stranger is untouched…
      expect(await readProcessBirthIdentity(handle.pid)).toBe(realIdentity);
      // …and the record survives, because dropping it would erase the only
      // evidence an operator has.
      expect(
        (await listProcessRecords()).find((r) => r.sessionId === "s-reused")
      ).toBeDefined();

      await sup.stopSession("s-live");
      await handle.kill();
      await forgetProcess("s-reused");
    },
    20_000
  );

  it.skipIf(!canOwnProcesses)(
    "reclaims a tree abandoned by a dead Inspector process",
    async () => {
      const dead = new LocalHarnessSupervisor({
        limits: { terminationGraceMs: 300 },
      });
      const handle = await dead.spawnSupervised({
        sessionId: "s-orphan",
        executable: process.execPath,
        args: [join(scripts, "idle.js")],
        workingDirectory: base,
        env: { PATH: "/usr/bin:/bin" },
        runtimeId: "rt_test",
        workspaceGrantId: "ws_test",
        targetKind: "local-native",
        sessionStateDir: join(base, "state-orphan"),
        role: "root",
      });

      // A different Inspector instance starts up and sweeps.
      const results = await reclaimAbandonedProcesses({
        liveNonce: mintSupervisorNonce(),
        graceMs: 300,
      });
      expect(results).toContainEqual({
        sessionId: "s-orphan",
        outcome: "terminated",
      });
      expect(await readProcessBirthIdentity(handle.pid)).toBeNull();
      expect(
        (await listProcessRecords()).find((r) => r.sessionId === "s-orphan")
      ).toBeUndefined();
    },
    20_000
  );

  it("cannot be turned into an arbitrary-delete primitive by a corrupt record", async () => {
    const outside = join(base, "not-session-state");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "important"), "keep me");
    await recordProcess(
      record({
        sessionId: "s-evil",
        rootPid: 2_147_480_001,
        sessionStateDir: outside,
      })
    );
    await reclaimAbandonedProcesses({ liveNonce: "sup_live" });
    // The record is dropped (its process is gone), but the directory outside
    // the local harness state root is untouched.
    expect(await readdir(outside)).toEqual(["important"]);
  });

  it("proves nothing and touches nothing where ownership is unprovable", async () => {
    await recordProcess(record({ sessionId: "s-win", rootPid: 4711 }));
    const results = await reclaimAbandonedProcesses({
      liveNonce: "sup_live",
      platform: "win32",
    });
    expect(results).toContainEqual({
      sessionId: "s-win",
      outcome: "skipped-unprovable",
    });
    expect(
      (await listProcessRecords()).find((r) => r.sessionId === "s-win")
    ).toBeDefined();
  });
});
