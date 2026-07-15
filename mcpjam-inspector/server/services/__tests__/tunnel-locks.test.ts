import { describe, it, expect } from "vitest";
import { withTunnelLock } from "../tunnel-locks.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("withTunnelLock", () => {
  it("serializes operations for the same server", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => (releaseFirst = r));

    const first = withTunnelLock("alpha", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = withTunnelLock("alpha", async () => {
      events.push("second:start");
      return 2;
    });

    await tick();
    // Second must not start while first holds the lock.
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("does not serialize across different servers", async () => {
    const events: string[] = [];
    let releaseAlpha!: () => void;
    const alphaGate = new Promise<void>((r) => (releaseAlpha = r));

    const alpha = withTunnelLock("alpha", async () => {
      events.push("alpha:start");
      await alphaGate;
    });
    const beta = withTunnelLock("beta", async () => {
      events.push("beta:done");
    });

    await beta;
    expect(events).toContain("beta:done");
    releaseAlpha();
    await alpha;
  });

  it("releases the lock when an operation rejects", async () => {
    await expect(
      withTunnelLock("alpha", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    // A queued/following operation still runs and gets its own result.
    expect(await withTunnelLock("alpha", async () => "recovered")).toBe(
      "recovered"
    );
  });

  it("propagates each operation's own rejection, not its predecessor's", async () => {
    const failing = withTunnelLock("alpha", async () => {
      throw new Error("first failed");
    });
    const following = withTunnelLock("alpha", async () => "ok");

    await expect(failing).rejects.toThrow("first failed");
    expect(await following).toBe("ok");
  });
});
