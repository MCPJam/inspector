import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_HOME_COMMAND,
  bridgeReapSchedule,
  readAheadToAwait,
  sandboxHomeLookup,
} from "../startup-overlap";

const STATE = "/home/user/.ai-sdk-harness/.agent-runs/run1/bridge";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bridgeReapSchedule", () => {
  it("reaps before every bridge spawn with the switch off", async () => {
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({ reap, unusedBox: () => true });
    await reaps.beforeSpawn(STATE);
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(2);
    expect(reap).toHaveBeenCalledWith(STATE, undefined);
  });

  it("skips only the first spawn's reap on a box no turn has used", async () => {
    vi.stubEnv("MCPJAM_HARNESS_SKIP_FIRST_REAP", "1");
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({ reap, unusedBox: () => true });
    await reaps.beforeSpawn(STATE);
    expect(reap).not.toHaveBeenCalled();
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it("still reaps on a box a turn has used", async () => {
    vi.stubEnv("MCPJAM_HARNESS_SKIP_FIRST_REAP", "1");
    const reap = vi.fn(async () => {});
    await bridgeReapSchedule({ reap, unusedBox: () => false }).beforeSpawn(STATE);
    await bridgeReapSchedule({ reap }).beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(2);
  });
});

describe("readAheadToAwait", () => {
  it("has the session wait for the read-ahead by default", async () => {
    const readAhead = Promise.resolve();
    expect(readAheadToAwait(readAhead)).toEqual([readAhead]);
  });

  it("lets it run on its own in background mode, without an unhandled rejection", async () => {
    vi.stubEnv("MCPJAM_HARNESS_READ_AHEAD", "background");
    const cancelled = Promise.reject(new Error("aborted"));
    expect(readAheadToAwait(cancelled)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("sandboxHomeLookup", () => {
  it("is off unless switched on", () => {
    expect(
      sandboxHomeLookup({ sandboxId: "box", command: SANDBOX_HOME_COMMAND, setsHome: false }),
    ).toBeUndefined();
  });

  it("asks a box for its home once, then answers from what it said", () => {
    vi.stubEnv("MCPJAM_HARNESS_MEMO_HOME", "1");
    const first = sandboxHomeLookup({ sandboxId: "box-a", command: SANDBOX_HOME_COMMAND, setsHome: false });
    expect(first?.known).toBeUndefined();
    first?.keep(0, "/home/user");
    expect(
      sandboxHomeLookup({ sandboxId: "box-a", command: SANDBOX_HOME_COMMAND, setsHome: false })?.known,
    ).toBe("/home/user");
    expect(
      sandboxHomeLookup({ sandboxId: "box-b", command: SANDBOX_HOME_COMMAND, setsHome: false })?.known,
    ).toBeUndefined();
  });

  it("keeps nothing from a failed run or an answer that isn't a home", () => {
    vi.stubEnv("MCPJAM_HARNESS_MEMO_HOME", "1");
    const lookup = () =>
      sandboxHomeLookup({ sandboxId: "box-c", command: SANDBOX_HOME_COMMAND, setsHome: false });
    lookup()?.keep(1, "/home/user");
    lookup()?.keep(0, "relative\npath");
    expect(lookup()?.known).toBeUndefined();
  });

  it("leaves other commands, and a command that sets HOME, to the box", () => {
    vi.stubEnv("MCPJAM_HARNESS_MEMO_HOME", "1");
    expect(sandboxHomeLookup({ sandboxId: "box", command: "ls", setsHome: false })).toBeUndefined();
    expect(
      sandboxHomeLookup({ sandboxId: "box", command: SANDBOX_HOME_COMMAND, setsHome: true }),
    ).toBeUndefined();
  });
});
