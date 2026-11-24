import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX_HOME_COMMAND,
  bridgeReapSchedule,
  readAheadInBackground,
  sandboxHomeLookup,
} from "../startup-overlap";

const STATE = "/home/user/.ai-sdk-harness/.agent-runs/run1/bridge";

describe("bridgeReapSchedule", () => {
  it("skips only the first spawn's reap on a box no turn has used", async () => {
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({ reap, unusedBox: () => true });
    await reaps.beforeSpawn(STATE);
    expect(reap).not.toHaveBeenCalled();
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(1);
    expect(reap).toHaveBeenCalledWith(STATE, undefined);
  });

  it("reaps before every spawn on a box a turn has used, or one it can't vouch for", async () => {
    const reap = vi.fn(async () => {});
    const used = bridgeReapSchedule({ reap, unusedBox: () => false });
    await used.beforeSpawn(STATE);
    await used.beforeSpawn(STATE);
    await bridgeReapSchedule({ reap }).beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(3);
  });
});

describe("readAheadInBackground", () => {
  it("lets a cancelled hint stop without an unhandled rejection", async () => {
    readAheadInBackground(Promise.reject(new Error("aborted")));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("sandboxHomeLookup", () => {
  it("asks a box for its home once, then answers from what it said", () => {
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
    const lookup = () =>
      sandboxHomeLookup({ sandboxId: "box-c", command: SANDBOX_HOME_COMMAND, setsHome: false });
    lookup()?.keep(1, "/home/user");
    lookup()?.keep(0, "relative\npath");
    expect(lookup()?.known).toBeUndefined();
  });

  it("leaves other commands, and a command that sets HOME, to the box", () => {
    expect(sandboxHomeLookup({ sandboxId: "box", command: "ls", setsHome: false })).toBeUndefined();
    expect(
      sandboxHomeLookup({ sandboxId: "box", command: SANDBOX_HOME_COMMAND, setsHome: true }),
    ).toBeUndefined();
  });
});
