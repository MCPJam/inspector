import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseDarwinPsLine,
  parseLinuxProcStat,
  readProcessBirthIdentity,
  parseProcStatGroup,
  probeProcessGroup,
  supportsOwnershipProof,
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
