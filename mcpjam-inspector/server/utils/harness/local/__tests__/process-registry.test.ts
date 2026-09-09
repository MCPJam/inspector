import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  probeProcess,
  supportsOwnershipProof,
  readProcessBirthIdentity,
} from "../process-identity.js";
import {
  forgetProcess,
  janitorOutcomeForUnsettled,
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
  overrides: Partial<LocalHarnessProcessRecord> = {},
): LocalHarnessProcessRecord {
  return {
    sessionId: "s-x",
    supervisorNonce: "sup_dead",
    // A pid that cannot be running, so the janitor can PROVE the owning
    // supervisor is gone. A record without this is treated as still-owned,
    // because "cannot prove the owner exited" never authorizes a kill.
    supervisorPid: 2_147_479_000,
    supervisorBirthIdentity: "linux:1",
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

/**
 * A detached group leader that spawns one long-lived grandchild, reports its
 * pid and then idles. Killing the leader leaves the GROUP live with its leader
 * gone — the shape that makes a recorded pgid unprovable.
 */
const LEADER_WITH_SURVIVOR = [
  "const{spawn}=require('node:child_process');",
  "const k=spawn(process.execPath,['-e',",
  JSON.stringify("setInterval(()=>{},1000)"),
  "],{stdio:'ignore'});",
  "console.log(k.pid);",
  "setInterval(()=>{},1000);",
].join("");

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-registry-")));
  process.env.HOME = base;
  scripts = join(base, "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "idle.js"),
    "console.log('ready');setInterval(()=>{},1000);",
  );
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

beforeEach(async () => {
  for (const r of await listProcessRecords()) await forgetProcess(r.sessionId);
});

describe("the cross-process lock", () => {
  const lockFile = () =>
    join(base, ".mcpjam", "harness-local", "processes.lock");

  it("breaks a lock whose holder is provably gone", async () => {
    await mkdir(join(base, ".mcpjam", "harness-local"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      lockFile(),
      JSON.stringify({ pid: 2_147_479_001, nonce: "n", at: Date.now() }),
    );
    // No wait, no staleness: the pid cannot exist, so the lock is abandoned.
    await expect(
      recordProcess(record({ sessionId: "s-lock-dead" })),
    ).resolves.toBeUndefined();
  });

  it("will not steal a lock from a holder that is still alive", async () => {
    // The hole this closes: an age-only break let a second Inspector into the
    // critical section while the first was still inside — and a janitor sweep
    // can exceed the staleness bound on its own, since each abandoned tree
    // costs up to ~10s to terminate. Waiting is the safe failure; a lost
    // record leaves a live tree with no durable handle on it.
    await mkdir(join(base, ".mcpjam", "harness-local"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      lockFile(),
      // This process: unambiguously alive, and far older than the staleness
      // bound, which on its own used to be enough to break it.
      JSON.stringify({
        pid: process.pid,
        nonce: "someone-else",
        at: Date.now() - 120_000,
      }),
    );

    let settled = false;
    const pending = recordProcess(record({ sessionId: "s-lock-live" })).then(
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 1_500));
    // Still waiting — it did not take the lock, and the holder's lock file is
    // untouched.
    expect(settled).toBe(false);
    expect(JSON.parse(await readFile(lockFile(), "utf8")).nonce).toBe(
      "someone-else",
    );

    // Waiting, not wedged: once the holder lets go, the mutation proceeds.
    await rm(lockFile(), { force: true });
    await pending;
    expect(settled).toBe(true);
  });

  it("recovers from a lock body that names nobody", async () => {
    // Truncated, or written by a build that recorded no holder. No probe can
    // ever resolve it, so age is the only recovery it has.
    await mkdir(join(base, ".mcpjam", "harness-local"), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(lockFile(), "{not json");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockFile(), old, old);
    await expect(
      recordProcess(record({ sessionId: "s-lock-garbage" })),
    ).resolves.toBeUndefined();
  });
});

describe("the durable record", () => {
  it("round-trips and updates lifecycle state", async () => {
    await recordProcess(record({ sessionId: "s-round" }));
    await updateLifecycleState("s-round", "suspended");
    const stored = (await listProcessRecords()).find(
      (r) => r.sessionId === "s-round",
    );
    expect(stored?.lifecycleState).toBe("suspended");
  });

  it("replaces a record for the same session rather than accumulating", async () => {
    await recordProcess(record({ sessionId: "s-dup", rootPid: 10 }));
    await recordProcess(record({ sessionId: "s-dup", rootPid: 11 }));
    const stored = (await listProcessRecords()).filter(
      (r) => r.sessionId === "s-dup",
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.rootPid).toBe(11);
  });
});

describe("reporting an unsettled termination", () => {
  it("keeps 'could not prove' apart from 'not ours'", () => {
    // The janitor said `not-owned` for both, which announces a pid-reuse
    // mismatch that was never established. They want opposite follow-ups: a
    // real mismatch is terminal and the record should stay for a human to look
    // at, while an unprovable answer is transient and the next sweep should
    // just try again. Every other blind spot in this file already says
    // `skipped-unprovable`.
    //
    // This stopped being academic when the group signal was gated on an
    // ownership anchor: `unknown` became a routine answer for a tree whose
    // root exited on its own, not just a rare probe failure.
    expect(janitorOutcomeForUnsettled("unknown")).toBe("skipped-unprovable");
    expect(janitorOutcomeForUnsettled("not-owned")).toBe("not-owned");
    expect(janitorOutcomeForUnsettled("escaped")).toBe("escaped");
  });
});

describe("the janitor", () => {
  it.skipIf(!canOwnProcesses)(
    "keeps a record whose group it could not vouch for while survivors remain",
    async () => {
      // A record the janitor cannot make sense of must not lose its handle:
      // an earlier version deleted it anyway, leaving the survivors
      // unreapable. (The `processGroupIdentity` gate this once gated a signal
      // on is gone — see the test below — but a malformed record still has to
      // keep its survivors visible.)
      const { spawn } = await import("node:child_process");
      // A group leader that spawns a grandchild, then dies: the group outlives
      // it, which is exactly the case the check exists for.
      const leader = spawn(
        process.execPath,
        [
          "-e",
          "const{spawn}=require('node:child_process');" +
            "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
            "setInterval(()=>{},1000);",
        ],
        { detached: true, stdio: "ignore" },
      );
      const pid = leader.pid!;
      await new Promise((r) => setTimeout(r, 400));
      process.kill(pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 300));

      await recordProcess(
        record({
          sessionId: "s-unvouched",
          rootPid: pid,
          processGroupIdentity: "not-the-root-pid",
        }),
      );
      const results = await reclaimAbandonedProcesses({
        liveNonce: "sup_live",
      });
      expect(results).toContainEqual({
        sessionId: "s-unvouched",
        outcome: "escaped",
      });
      expect(
        (await listProcessRecords()).find((r) => r.sessionId === "s-unvouched"),
      ).toBeDefined();

      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await forgetProcess("s-unvouched");
    },
  );

  it.skipIf(!canOwnProcesses)(
    "reports survivors of a dead root without signalling their group",
    async () => {
      // The janitor reaches this branch only for a record whose owning
      // supervisor has PROVABLY exited, so arbitrary time has passed since
      // anything of ours was last in that group.
      //
      // A pid in use as a process-group id is not reissued while that group
      // has members — but that is a promise about a group that still has one,
      // not about one that emptied. If this tree finished normally its id went
      // free, and any unrelated process could since have taken that pid, led a
      // new group with it and exited, leaving a live group under our recorded
      // id (an ordinary shell pipeline whose first stage exits early does
      // exactly this). Nothing here can tell those apart, so the survivors are
      // reported and the record kept, and NO signal is sent.
      const { spawn } = await import("node:child_process");
      const leader = spawn(process.execPath, ["-e", LEADER_WITH_SURVIVOR], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const pid = leader.pid!;
      // Everything from here is guarded: a rejected handshake or a failed
      // assertion outside the `try` would leak a detached leader and its
      // child, and nothing reaps a detached group leader.
      let survivor = 0;
      try {
        survivor = Number(
          await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("the fixture never announced its child")),
              10_000,
            );
            leader.once("error", reject);
            leader.stdout!.once("data", (d: Buffer) => {
              clearTimeout(timer);
              resolve(d.toString().trim());
            });
          }),
        );
        expect(survivor).toBeGreaterThan(0);
        // Kill the ROOT only. The group outlives it.
        process.kill(pid, "SIGKILL");
        for (let i = 0; i < 200; i++) {
          if ((await probeProcess(pid)).state === "gone") break;
          await new Promise((r) => setTimeout(r, 25));
        }
        expect((await probeProcess(pid)).state).toBe("gone");

        // A WELL-FORMED record: the group id is exactly the recorded root pid,
        // which is what the removed gate vouched for. That is what makes this
        // discriminating — the old code signalled precisely here.
        await recordProcess(
          record({
            sessionId: "s-live-group",
            rootPid: pid,
            processGroupIdentity: String(pid),
          }),
        );
        const results = await reclaimAbandonedProcesses({
          liveNonce: "sup_live",
        });
        expect(results).toContainEqual({
          sessionId: "s-live-group",
          outcome: "escaped",
        });
        expect(
          (await listProcessRecords()).find(
            (r) => r.sessionId === "s-live-group",
          ),
        ).toBeDefined();
        // The point of the test: the group was not signalled.
        expect((await probeProcess(survivor)).state).toBe("alive");
      } finally {
        if (survivor > 0) {
          try {
            process.kill(survivor, "SIGKILL");
          } catch {
            /* already gone */
          }
        } else {
          // Never named: the root has not been signalled, so its group id is
          // provably still ours and this is the only way to reach the child.
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        await forgetProcess("s-live-group");
      }
    },
  );

  it.skipIf(!canOwnProcesses)(
    "will not reclaim records owned by a supervisor that is still alive",
    async () => {
      // A foreign nonce means "another supervisor made this", NOT "that
      // supervisor is gone". A second Inspector window must not kill the first's
      // live sessions.
      await recordProcess(
        record({
          sessionId: "s-other-live",
          supervisorPid: process.pid,
          supervisorBirthIdentity:
            (await readProcessBirthIdentity(process.pid)) ?? "linux:0",
        }),
      );
      const results = await reclaimAbandonedProcesses({
        liveNonce: "sup_live",
      });
      expect(results).toContainEqual({
        sessionId: "s-other-live",
        outcome: "skipped-live-supervisor",
      });
      expect(
        (await listProcessRecords()).find(
          (r) => r.sessionId === "s-other-live",
        ),
      ).toBeDefined();
      await forgetProcess("s-other-live");
    },
  );

  it.skipIf(!canOwnProcesses)(
    "treats a record with no recorded owner as still-owned",
    async () => {
      // Written before supervisor liveness was recorded: we cannot prove the
      // owner exited, so it is left alone rather than reclaimed on a guess.
      const legacy = record({ sessionId: "s-legacy" });
      delete (legacy as { supervisorPid?: number }).supervisorPid;
      delete (legacy as { supervisorBirthIdentity?: string })
        .supervisorBirthIdentity;
      await recordProcess(legacy);
      const results = await reclaimAbandonedProcesses({
        liveNonce: "sup_live",
      });
      expect(results).toContainEqual({
        sessionId: "s-legacy",
        outcome: "skipped-live-supervisor",
      });
      await forgetProcess("s-legacy");
    },
  );

  it("leaves the live supervisor's own sessions alone", async () => {
    const nonce = mintSupervisorNonce();
    await recordProcess(
      record({ sessionId: "s-mine", supervisorNonce: nonce }),
    );
    const results = await reclaimAbandonedProcesses({ liveNonce: nonce });
    expect(results).toContainEqual({
      sessionId: "s-mine",
      outcome: "skipped-live-supervisor",
    });
    expect(await listProcessRecords()).toHaveLength(1);
  });

  it.skipIf(!canOwnProcesses)(
    "drops a record whose process is simply gone, and cleans its state",
    async () => {
      const sessionStateDir = join(
        base,
        ".mcpjam",
        "harness-local",
        "sessions",
        "s-gone",
      );
      await mkdir(sessionStateDir, { recursive: true });
      await writeFile(join(sessionStateDir, "leftover"), "x");
      // A pid that has certainly exited: this test's own throwaway child.
      await recordProcess(
        record({
          sessionId: "s-gone",
          rootPid: 2_147_480_000,
          sessionStateDir,
        }),
      );
      const results = await reclaimAbandonedProcesses({
        liveNonce: "sup_live",
      });
      expect(results).toContainEqual({
        sessionId: "s-gone",
        outcome: "already-gone",
      });
      expect(await listProcessRecords()).toHaveLength(0);
      await expect(readdir(sessionStateDir)).rejects.toThrow();
    },
  );

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
        }),
      );

      const results = await reclaimAbandonedProcesses({
        liveNonce: "sup_live",
      });
      expect(results).toContainEqual({
        sessionId: "s-reused",
        outcome: "not-owned",
      });
      // The stranger is untouched…
      expect(await readProcessBirthIdentity(handle.pid)).toBe(realIdentity);
      // …and the record survives, because dropping it would erase the only
      // evidence an operator has.
      expect(
        (await listProcessRecords()).find((r) => r.sessionId === "s-reused"),
      ).toBeDefined();

      await sup.stopSession("s-live");
      await handle.kill();
      await forgetProcess("s-reused");
    },
    20_000,
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

      // Simulate that Inspector having EXITED. The supervisor above runs in
      // this very process, so its recorded owner is alive and the janitor
      // would rightly leave it alone; rewriting the owner to a pid that cannot
      // be running is what makes this the abandoned-tree case it claims to be.
      const stored = (await listProcessRecords()).find(
        (r) => r.sessionId === "s-orphan",
      );
      expect(stored).toBeDefined();
      await recordProcess({
        ...stored!,
        supervisorPid: 2_147_479_001,
        supervisorBirthIdentity: "linux:1",
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
        (await listProcessRecords()).find((r) => r.sessionId === "s-orphan"),
      ).toBeUndefined();
    },
    20_000,
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
      }),
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
      (await listProcessRecords()).find((r) => r.sessionId === "s-win"),
    ).toBeDefined();
  });
});
