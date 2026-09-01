import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  parseDarwinPsLine,
  parseLinuxProcStat,
  readProcessBirthIdentity,
  supportsOwnershipProof,
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
    expect(parseLinuxProcStat(raw)).toEqual({ state: "S", starttime: "998877" });
  });

  it("returns null for anything that is not a stat line", () => {
    expect(parseLinuxProcStat("")).toBeNull();
    expect(parseLinuxProcStat("no parens here")).toBeNull();
    expect(parseLinuxProcStat("1 (x) ")).toBeNull();
  });
});

describe("parseDarwinPsLine", () => {
  it("splits the state from the start time", () => {
    expect(parseDarwinPsLine("S     Mon Sep  1 01:00:00 2026\n")).toEqual({
      state: "S",
      lstart: "Mon Sep  1 01:00:00 2026",
    });
  });

  it("keeps only the first character meaningful for decorated states", () => {
    // macOS decorates state with modifiers: `Ss`, `S+`, `R<`.
    expect(parseDarwinPsLine("Ss+   Mon Sep  1 01:00:00 2026")?.state).toBe("Ss+");
    expect(parseDarwinPsLine("Z     Mon Sep  1 01:00:00 2026")?.state).toBe("Z");
  });

  it("returns null for empty or truncated output", () => {
    expect(parseDarwinPsLine("")).toBeNull();
    expect(parseDarwinPsLine("   ")).toBeNull();
    expect(parseDarwinPsLine("S")).toBeNull();
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
        `linux:${parsed!.starttime}`
      );
    }
  );
});
