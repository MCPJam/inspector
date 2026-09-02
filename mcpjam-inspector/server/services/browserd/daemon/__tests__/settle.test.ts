import { describe, expect, it, vi } from "vitest";
import { settlePage, type SettleSteps } from "../settle";

const resolved = async () => {};

/** A step that never resolves on its own; it rejects when its signal aborts. */
function hangsUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

describe("settlePage (L2)", () => {
  it("reports settled:true when the sequence completes within budget", async () => {
    const steps: SettleSteps = {
      waitForCommit: resolved,
      waitForNetworkQuiet: resolved,
      waitForAnimationFrame: resolved,
    };
    expect(await settlePage(steps, { maxWaitMs: 1000 })).toEqual({ settled: true });
  });

  it("runs the steps in order: commit → network-quiet → animation frame", async () => {
    const order: string[] = [];
    const steps: SettleSteps = {
      waitForCommit: async () => void order.push("commit"),
      waitForNetworkQuiet: async () => void order.push("network"),
      waitForAnimationFrame: async () => void order.push("raf"),
    };
    await settlePage(steps, { maxWaitMs: 1000 });
    expect(order).toEqual(["commit", "network", "raf"]);
  });

  it("returns settled:false (never throws) when the page won't settle in time", async () => {
    const waitForNetworkQuiet = vi.fn(hangsUntilAborted);
    const steps: SettleSteps = {
      waitForCommit: resolved,
      waitForNetworkQuiet,
      waitForAnimationFrame: resolved,
    };
    expect(await settlePage(steps, { maxWaitMs: 10 })).toEqual({ settled: false });
    // the hung step was actually aborted, not left dangling
    expect(waitForNetworkQuiet.mock.calls[0][0].aborted).toBe(true);
  });

  it("propagates a real failure (a crash is not mere slowness)", async () => {
    const steps: SettleSteps = {
      waitForCommit: async () => {
        throw new Error("target crashed");
      },
      waitForNetworkQuiet: resolved,
      waitForAnimationFrame: resolved,
    };
    await expect(settlePage(steps, { maxWaitMs: 1000 })).rejects.toThrow(
      "target crashed",
    );
  });
});
