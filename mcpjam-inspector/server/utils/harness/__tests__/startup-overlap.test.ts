import { afterEach, describe, expect, it, vi } from "vitest";
import { EARLY_REAP_STATE_DIR, bridgeReapSchedule } from "../startup-overlap";

const STATE = "/home/user/.ai-sdk-harness/.agent-runs/run1/bridge";

describe("bridgeReapSchedule", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reaps before every bridge spawn with no switch on", async () => {
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({
      resuming: false,
      reap,
      firstTurnOnNewBox: () => true,
    });
    await reaps.beforeSpawn(STATE);
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(2);
    expect(reap).toHaveBeenCalledWith(STATE, undefined);
  });

  it("skips only the first spawn's reap on a conversation's first turn on its new box", async () => {
    vi.stubEnv("MCPJAM_HARNESS_SKIP_FIRST_REAP", "1");
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({
      resuming: false,
      reap,
      firstTurnOnNewBox: () => true,
    });
    await reaps.beforeSpawn(STATE);
    expect(reap).not.toHaveBeenCalled();
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it("still reaps on a box that is not the conversation's new one", async () => {
    vi.stubEnv("MCPJAM_HARNESS_SKIP_FIRST_REAP", "1");
    const reap = vi.fn(async () => {});
    await bridgeReapSchedule({
      resuming: false,
      reap,
      firstTurnOnNewBox: () => false,
    }).beforeSpawn(STATE);
    await bridgeReapSchedule({ resuming: false, reap }).beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh session's reap early and has its first spawn wait for that one", async () => {
    vi.stubEnv("MCPJAM_HARNESS_EARLY_REAP", "1");
    let finish!: () => void;
    const reap = vi.fn(
      (stateDir: string) =>
        new Promise<void>((resolve) => {
          if (stateDir === EARLY_REAP_STATE_DIR) finish = resolve;
          else resolve();
        }),
    );
    const reaps = bridgeReapSchedule({ resuming: false, reap });
    expect(reap).toHaveBeenCalledWith(EARLY_REAP_STATE_DIR, undefined);
    let spawned = false;
    const first = reaps.beforeSpawn(STATE).then(() => {
      spawned = true;
    });
    await Promise.resolve();
    expect(spawned).toBe(false);
    finish();
    await first;
    expect(reap).toHaveBeenCalledTimes(1);
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenLastCalledWith(STATE, undefined);
  });

  it("never reaps early on a resume", async () => {
    vi.stubEnv("MCPJAM_HARNESS_EARLY_REAP", "1");
    const reap = vi.fn(async () => {});
    const reaps = bridgeReapSchedule({ resuming: true, reap });
    expect(reap).not.toHaveBeenCalled();
    await reaps.beforeSpawn(STATE);
    expect(reap).toHaveBeenCalledWith(STATE, undefined);
  });
});
