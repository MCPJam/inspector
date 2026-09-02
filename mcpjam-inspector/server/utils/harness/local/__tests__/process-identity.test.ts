import { readFile } from "node:fs/promises";
import { describe, expect, it, afterEach } from "vitest";
import {
  listGroupMembers,
  parseDarwinPsLine,
  parseLinuxProcStat,
  parseProcStatGroup,
  probeProcess,
  probeProcessGroup,
  readProcessBirthIdentity,
  sameBirthIdentity,
  setWindowsJobLauncherVerified,
  supportsOwnershipProof,
  terminateOwnedProcess,
  terminateOwnedProcessGroup,
} from "../process-identity.js";

/**
 * A ZOMBIE keeps its `/proc/<pid>/stat` entry, so a liveness check built on
 * "can I read the stat file" calls a dead process alive. Downstream that means
 * a tree we successfully killed is reported as having escaped, `stopSession`
 * refuses to say the session stopped, and the janitor never reclaims it.
 *
 * Whether it is ever observed depends on the environment: when PID 1 reaps
 * orphans, a killed descendant vanishes at once. Inside a container whose PID 1
 * is an application rather than a real init — which is where CI runs — the
 * zombie persists indefinitely. Captured from a real zombie rather than
 * hand-written, so the field layout is the kernel's and not our guess.
 */
const ZOMBIE_STAT =
  "4974 (perl) Z 4973 4970 4967 0 -1 4227148 76 0 0 0 0 0 0 0 20 0 1 0 " +
  "343248 0 0 18446744073709551615 0 0 0 0 0 0 0 128 0 1 0 0 17 0 0 0 0 0 0 " +
  "0 0 0 0 0 0 0 0\n";

const RUNNING_STAT =
  "1234 (node) S 1200 1234 1200 0 -1 4194304 5000 0 0 0 10 5 0 0 20 0 11 0 " +
  "998877 123456789 2000 18446744073709551615 1 1 0 0 0 0 0 4096 16898 1 0 0 " +
  "17 2 0 0 0 0 0 0 0 0 0 0 0 0 0\n";

describe("parseLinuxProcStat", () => {
  it("reads state and starttime past a parenthesized comm", () => {
    expect(parseLinuxProcStat(RUNNING_STAT)).toEqual({
      state: "S",
      starttime: "998877",
    });
  });

  it("reports a zombie's state, so the caller can treat it as dead", () => {
    expect(parseLinuxProcStat(ZOMBIE_STAT)).toEqual({
      state: "Z",
      starttime: "343248",
    });
  });

  it("survives a comm containing spaces and parens", () => {
    const raw = RUNNING_STAT.replace("(node)", "(my (odd) name)");
    expect(parseLinuxProcStat(raw)).toEqual({
      state: "S",
      starttime: "998877",
    });
  });

  it("returns null for anything that is not a stat line", () => {
    expect(parseLinuxProcStat("")).toBeNull();
    expect(parseLinuxProcStat("no parens here")).toBeNull();
    expect(parseLinuxProcStat("1 (x) ")).toBeNull();
  });
});

describe("parseDarwinPsLine", () => {
  it("splits state, the five-token start time, and the full argv", () => {
    expect(
      parseDarwinPsLine("S     Mon Sep  1 01:00:00 2026 /usr/local/bin/node\n"),
    ).toEqual({
      // Whitespace-normalized: `ps` space-pads a single-digit day, and an
      // identity that changed with the padding would be a worse discriminator,
      // not a better one.
      state: "S",
      lstart: "Mon Sep 1 01:00:00 2026",
      command: "/usr/local/bin/node",
    });
  });

  it("keeps the arguments, not just the executable name", () => {
    // The whole point of `command=` over `comm=`: two instances of the same
    // program started in the same second are only distinguishable by argv, and
    // a supervised bridge's argv carries its session's own paths.
    expect(
      parseDarwinPsLine(
        "S Mon Sep  1 01:00:00 2026 /usr/bin/node /bundle/bridge.mjs --workdir /w/a",
      )?.command,
    ).toBe("/usr/bin/node /bundle/bridge.mjs --workdir /w/a");
  });

  it("keeps a command containing spaces intact", () => {
    // The lstart field is a fixed FIVE tokens, so the split is positional and
    // does not assume `comm` is one token — which it is not for an app bundle.
    expect(
      parseDarwinPsLine(
        "Ss   Mon Sep  1 01:00:00 2026 /Applications/My App.app/Contents/MacOS/My App",
      ),
    ).toEqual({
      state: "Ss",
      lstart: "Mon Sep 1 01:00:00 2026",
      command: "/Applications/My App.app/Contents/MacOS/My App",
    });
  });

  it("preserves the full decorated state, leaving the caller to read its first char", () => {
    // macOS decorates state with modifiers: `Ss`, `S+`, `R<`. The parser keeps
    // them; `readDarwinBirthIdentity` is what looks at charAt(0) to decide
    // whether the state is a dead one.
    expect(
      parseDarwinPsLine("Ss+   Mon Sep  1 01:00:00 2026 /bin/x")?.state,
    ).toBe("Ss+");
    expect(
      parseDarwinPsLine("Z     Mon Sep  1 01:00:00 2026 /bin/x")?.state,
    ).toBe("Z");
  });

  it("returns null for empty or truncated output", () => {
    expect(parseDarwinPsLine("")).toBeNull();
    expect(parseDarwinPsLine("   ")).toBeNull();
    expect(parseDarwinPsLine("S")).toBeNull();
    expect(parseDarwinPsLine("S Mon Sep 1 01:00:00")).toBeNull();
  });
});

describe.skipIf(!supportsOwnershipProof())("readProcessBirthIdentity", () => {
  it("identifies this very process", async () => {
    const identity = await readProcessBirthIdentity(process.pid);
    expect(identity).not.toBeNull();
    // Stable across reads — it is what proves a pid has not been reused.
    expect(await readProcessBirthIdentity(process.pid)).toBe(identity);
  });

  it("returns null for a pid that does not exist", async () => {
    expect(await readProcessBirthIdentity(2_147_480_000)).toBeNull();
  });

  it("returns null for an implausible pid", async () => {
    expect(await readProcessBirthIdentity(0)).toBeNull();
    expect(await readProcessBirthIdentity(-1)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")(
    "reads a live process as alive through the same path the zombie test covers",
    async () => {
      const raw = await readFile(`/proc/${process.pid}/stat`, "utf8");
      const parsed = parseLinuxProcStat(raw);
      expect(parsed).not.toBeNull();
      expect(parsed!.state).not.toBe("Z");
      expect(await readProcessBirthIdentity(process.pid)).toBe(
        `linux:${parsed!.starttime}`,
      );
    },
  );
});

describe("terminating a tree we own", () => {
  // These drive the real primitive against a real child so the outcomes are
  // the ones a session would actually see. The two that depend on a real
  // liveness answer are gated: on a platform with no ownership proof every
  // probe is `unknown`, so they would be asserting the wrong thing rather than
  // measuring anything. The `win32` case below is the one that DOES assert the
  // unprovable answer, and it runs everywhere.
  it.skipIf(!supportsOwnershipProof())(
    "reports the tree gone only when it is PROVABLY gone",
    async () => {
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      const pid = child.pid!;
      try {
        const identity = await readProcessBirthIdentity(pid);
        expect(identity).not.toBeNull();
        const outcome = await terminateOwnedProcessGroup({
          pid,
          birthIdentity: identity!,
          graceMs: 400,
          pollMs: 25,
        });
        expect(["graceful", "forced"]).toContain(outcome.outcome);
      } finally {
        // A failing assertion must not leak a detached process into the rest
        // of the run — it is in its own group, so nothing else would reap it.
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  );

  it("says 'unknown', not 'graceful', when the platform cannot be asked", async () => {
    // A platform with no liveness primitive answers `unknown` at every probe.
    // The old post-grace re-check went through `isSameProcess`, which folds
    // "gone", "not ours" and "could not look" into one `false` — so a probe
    // failure reported the tree as gracefully stopped.
    const outcome = await terminateOwnedProcessGroup({
      pid: 4_242,
      birthIdentity: "win32:whatever",
      graceMs: 10,
      pollMs: 5,
      platform: "win32",
    });
    expect(outcome.outcome).toBe("unknown");
  });

  it.skipIf(!supportsOwnershipProof())(
    "refuses to signal a pid that is no longer the process we recorded",
    async () => {
      const outcome = await terminateOwnedProcessGroup({
        pid: process.pid,
        birthIdentity: "linux:definitely-not-this-process",
        graceMs: 50,
        pollMs: 10,
      });
      expect(outcome.outcome).toBe("not-owned");
    },
  );
});

/**
 * A root that exits on SIGTERM, with a descendant in its group that ignores it.
 *
 * The descendant announces itself only AFTER installing its handler, and the
 * root relays its pid only after that — without the handshake, the SIGTERM
 * that starts termination can land before the handler is registered and kill
 * the descendant by default action, which quietly turns these tests into
 * something that measures nothing.
 */
const DESERTING_ROOT = [
  "const{spawn}=require('node:child_process');",
  "const k=spawn(process.execPath,['-e',",
  JSON.stringify(
    "process.on('SIGTERM',function(){});console.log('ready');" +
      "setInterval(()=>{},1000)",
  ),
  "],{stdio:['ignore','pipe','ignore']});",
  "k.stdout.once('data',function(){console.log(k.pid)});",
  "process.on('SIGTERM',function(){process.exit(0)});",
  "setInterval(()=>{},1000);",
].join("");

/**
 * A detached group leader that spawns one long-lived grandchild, reports its
 * pid and then idles. Killing the leader leaves the GROUP live with its leader
 * gone — the shape in which a recorded pgid can no longer be tied to us.
 */
const LEADER_WITH_SURVIVOR = [
  "const{spawn}=require('node:child_process');",
  "const k=spawn(process.execPath,['-e',",
  JSON.stringify("setInterval(()=>{},1000)"),
  "],{stdio:'ignore'});",
  "console.log(k.pid);",
  "setInterval(()=>{},1000);",
].join("");

/**
 * Spawn one of the fixtures above, wait for it to name its descendant, run the
 * body, and kill both whatever happens.
 *
 * The spawn and the handshake belong INSIDE the guarded region: a rejected
 * handshake or a failed assertion before the `try` would leak a detached group
 * leader and its child, each holding a `setInterval`, for the life of the host.
 * Nothing reaps a detached leader.
 */
async function withDetachedTree(
  script: string,
  body: (pid: number, descendant: number) => Promise<void>,
): Promise<void> {
  const { spawn } = await import("node:child_process");
  const root = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = root.pid!;
  let descendant = 0;
  try {
    descendant = Number(
      await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("the fixture never announced its descendant")),
          10_000,
        );
        root.once("error", reject);
        root.stdout!.once("data", (d: Buffer) => {
          clearTimeout(timer);
          resolve(d.toString().trim());
        });
      }),
    );
    expect(descendant).toBeGreaterThan(0);
    await body(pid, descendant);
  } finally {
    if (descendant > 0) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        /* already gone */
      }
    } else {
      // The handshake never named it. The root has not been signalled yet, so
      // it is still alive and its group id is provably still ours — the only
      // way to reach a descendant we cannot name.
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
  }
}

/** Poll until `pid` is provably gone, or give up. */
async function waitForGone(pid: number, timeoutMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await probeProcess(pid)).state === "gone") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("a group that cannot be enumerated", () => {
  it.skipIf(!supportsOwnershipProof())(
    "reports unknown and does NOT signal a group it cannot prove",
    async () => {
      // Shaped so that ONLY `settleGroup` could do the killing: the root exits
      // on SIGTERM, so the grace loop returns through `settleGroup("graceful")`
      // before the main flow's own SIGKILL is ever reached. A descendant that
      // ignores SIGTERM is therefore still alive at that point, and whether it
      // dies tells us exactly what `settleGroup` did.
      //
      // It must NOT die here. Every caller of `settleGroup` has already proven
      // the root gone, so its pid is reusable; `kill(-pid)` is only safe
      // because a group id is not reissued while the group has members, and
      // `unknown` is the failure to establish that. Signalling anyway risks a
      // stranger's group.
      await withDetachedTree(DESERTING_ROOT, async (pid, descendant) => {
        const identity = await readProcessBirthIdentity(pid);
        const outcome = await terminateOwnedProcessGroup({
          pid,
          birthIdentity: identity!,
          graceMs: 2_000,
          pollMs: 25,
          // Always unprovable, as an unreadable /proc would be.
          probeGroup: async () => "unknown",
        });
        expect(outcome.outcome).toBe("unknown");
        // The root cooperated and is gone...
        expect(await waitForGone(pid)).toBe(true);
        // ...and the descendant was left alone rather than signalled on an
        // unverifiable group id.
        expect((await probeProcess(descendant)).state).toBe("alive");
      });
    },
  );

  it.skipIf(!supportsOwnershipProof())(
    "DOES force-kill a group it can prove still has a member",
    async () => {
      // The counterpart. `live` alone would not earn this: it says a group
      // with our id exists, not that the group is ours. What earns it is the
      // anchor — this call proved the root alive and carrying its recorded
      // birth identity moments before, and a leader belongs to its own group,
      // so a stranger could not have created this one in between.
      await withDetachedTree(DESERTING_ROOT, async (pid, descendant) => {
        const identity = await readProcessBirthIdentity(pid);
        const outcome = await terminateOwnedProcessGroup({
          pid,
          birthIdentity: identity!,
          graceMs: 2_000,
          pollMs: 25,
        });
        expect(["forced", "graceful"]).toContain(outcome.outcome);
        expect(await waitForGone(descendant)).toBe(true);
      });
    },
  );
});

describe("a live group whose root was already gone", () => {
  it.skipIf(!supportsOwnershipProof())(
    "reports it rather than signalling a group nothing ties to this tree",
    async () => {
      // `live` proves a group with this id EXISTS. It does not prove the group
      // is ours, and the difference is the whole finding: the pid-reuse rule
      // ("an id in use as a process-group id is not reissued while that group
      // has members") is a promise about a group that still has one. A group
      // that emptied released its id, and an unrelated process could have
      // taken that pid, led a new group with it and exited — leaving a live
      // group under our id with nothing of ours in it.
      //
      // The other paths through `settleGroup` have an anchor: they proved the
      // root alive and carrying its recorded birth identity moments earlier,
      // and a leader belongs to its own group. This path has none — the root
      // was gone on the very first probe — so it must not signal.
      await withDetachedTree(LEADER_WITH_SURVIVOR, async (pid, survivor) => {
        // Read the identity while the root still has one, then kill ONLY the
        // root so the call below finds it gone on its first look.
        const identity = await readProcessBirthIdentity(pid);
        process.kill(pid, "SIGKILL");
        expect(await waitForGone(pid)).toBe(true);

        const outcome = await terminateOwnedProcessGroup({
          pid,
          birthIdentity: identity!,
          graceMs: 2_000,
          pollMs: 25,
        });
        // Not `forced`: nothing was killed, and nothing may be reported
        // stopped either.
        expect(outcome.outcome).toBe("unknown");
        expect((await probeProcess(survivor)).state).toBe("alive");
      });
    },
  );
});

describe("probing a process GROUP", () => {
  it("says 'unknown' where it cannot enumerate at all", async () => {
    // The bug this replaced: a boolean that mapped every failure to `false`,
    // which is what makes `terminateOwnedProcessGroup` report the tree gone
    // and what makes the janitor DROP a durable record. A platform with no
    // enumeration must not read as "the group is empty".
    await expect(probeProcessGroup(4_242, "win32")).resolves.toBe("unknown");
  });

  it("rejects an implausible pid without claiming the group is empty", async () => {
    await expect(probeProcessGroup(0)).resolves.toBe("unknown");
    await expect(probeProcessGroup(-1)).resolves.toBe("unknown");
  });

  it.skipIf(!supportsOwnershipProof())(
    "finds a live detached group, and an unused group id empty",
    async () => {
      // A detached child is its own group leader, so its pid IS the group id —
      // the shape the supervisor actually creates. (This test process is not:
      // its group leader is some ancestor.)
      const { spawn } = await import("node:child_process");
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        { detached: true, stdio: "ignore" },
      );
      const pid = child.pid!;
      try {
        await expect(probeProcessGroup(pid)).resolves.toBe("live");
      } finally {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      // A pid far above any plausible allocation: nothing is in that group.
      await expect(probeProcessGroup(2_147_479_100)).resolves.toBe("empty");
    },
  );

  it("reads the group id and state out of a /proc stat line", () => {
    // Field order after `comm`: state, ppid, pgrp. A comm containing spaces
    // and parens is why the split point is the LAST ')'.
    expect(
      parseProcStatGroup("77 (my proc) S 4 99 99 0 -1 4194304 100"),
    ).toEqual({ state: "S", pgrp: 99 });
    expect(parseProcStatGroup("garbage")).toBeNull();
  });
});

describe("identity comparison across a process's exit", () => {
  // On macOS a process that is exiting — argv memory already torn down, not
  // yet a zombie — is reported by `ps` with its command as `(comm)`. The
  // recorded identity carries the full argv, so a byte compare answered
  // "not-owned" for our own bridge the moment the adapter told it to exit, the
  // supervisor refused to signal it, and every clean stop was recorded as an
  // escape.
  const LSTART = "Mon Sep  1 09:14:22 2026";

  it("accepts the parenthesised command a darwin exit reports", () => {
    expect(
      sameBirthIdentity(
        `darwin:${LSTART}|node /pack/launcher.mjs --workdir /w`,
        `darwin:${LSTART}|(node)`,
      ),
    ).toBe(true);
  });

  it("still refuses a different start time, which is what pid reuse changes", () => {
    // The start time is the half that actually defeats pid reuse: a reused pid
    // gets a new one. Tolerating the command is only safe because this is not.
    expect(
      sameBirthIdentity(
        `darwin:${LSTART}|node /pack/launcher.mjs`,
        "darwin:Mon Sep  1 09:14:23 2026|(node)",
      ),
    ).toBe(false);
  });

  it("refuses a command that differs in any other way", () => {
    expect(
      sameBirthIdentity(
        `darwin:${LSTART}|node /pack/launcher.mjs`,
        `darwin:${LSTART}|node /somewhere/else.mjs`,
      ),
    ).toBe(false);
    // Not the parenthesised form: nested parens are not what `ps` produces.
    expect(
      sameBirthIdentity(
        `darwin:${LSTART}|node /pack/launcher.mjs`,
        `darwin:${LSTART}|(no(de))`,
      ),
    ).toBe(false);
  });

  it("is exact on platforms that do not have the darwin quirk", () => {
    expect(
      sameBirthIdentity("linux:12345|67890", "linux:12345|67890"),
    ).toBe(true);
    expect(sameBirthIdentity("linux:12345|67890", "linux:12346|67890")).toBe(
      false,
    );
    // A linux identity is never read through the darwin tolerance.
    expect(sameBirthIdentity("linux:12345|67890", "linux:12345|(node)")).toBe(
      false,
    );
  });
});

describe("enumerating group members for a later stop", () => {
  it.skipIf(!supportsOwnershipProof(process.platform))(
    "lists live members with an identity each, excluding the leader",
    async () => {
      // This process leads its own group in the test runner, so it is the one
      // group we can enumerate without spawning a tree.
      const members = await listGroupMembers(process.pid);
      expect(members).not.toBeNull();
      for (const member of members ?? []) {
        expect(member.pid).not.toBe(process.pid);
        expect(typeof member.identity).toBe("string");
        expect(member.identity.length).toBeGreaterThan(0);
      }
    },
  );

  it("answers null on a platform it cannot ask, rather than an empty list", async () => {
    // The difference matters: an empty list means "asked, nothing there" and
    // authorizes reporting a tree settled. `null` never does.
    await expect(listGroupMembers(1, "win32")).resolves.toBeNull();
  });
});

describe("terminating one member of a snapshot", () => {
  it("refuses a pid whose identity no longer matches", async () => {
    await expect(
      terminateOwnedProcess({
        pid: process.pid,
        identity: "definitely-not-this-process",
        graceMs: 20,
      }),
    ).resolves.toBe("not-owned");
  });

  it("reports a pid that is already gone without signalling anything", async () => {
    await expect(
      terminateOwnedProcess({
        pid: 2_147_479_100,
        identity: "whatever",
        graceMs: 20,
      }),
    ).resolves.toBe("already-gone");
  });
});

describe("ownership proof, per platform", () => {
  afterEach(() => setWindowsJobLauncherVerified(false));

  it("is provable on the POSIX platforms, where a process group is", () => {
    expect(supportsOwnershipProof("linux")).toBe(true);
    expect(supportsOwnershipProof("darwin")).toBe(true);
  });

  it("is NOT provable on Windows without a verified job launcher", () => {
    // Windows has no process group. `taskkill /T` walks a parent chain a
    // re-parented process has already left, so without a Job Object there is
    // nothing that makes "stop" mean stop — and an unenforced cleanup promise
    // is worse than no Windows support.
    expect(supportsOwnershipProof("win32")).toBe(false);
  });

  it("becomes provable on Windows once one is verified", () => {
    // Latched by runtime resolution, which is the only thing that can say the
    // helper is inside the tree whose digest consent named. A helper sitting
    // beside the pack would not qualify.
    setWindowsJobLauncherVerified(true);
    expect(supportsOwnershipProof("win32")).toBe(true);
  });

  it("stays unprovable everywhere else, whatever the latch says", () => {
    setWindowsJobLauncherVerified(true);
    for (const platform of ["aix", "freebsd", "sunos"] as NodeJS.Platform[]) {
      expect(supportsOwnershipProof(platform)).toBe(false);
    }
  });
});
