import { describe, expect, it, vi } from "vitest";
vi.mock("../readiness.js", () => ({ ensureLocalHarnessTarget: vi.fn() }));
import { withLocalHarnessSlot, assertLocalHarnessCapabilities } from "../run-resources.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
describe("shared local scheduler", () => {
  it("limits concurrent work to two and removes cancelled waiters without consuming a slot", async () => {
    const hold = deferred();
    let active = 0;
    let peak = 0;
    const work = async () => { active++; peak = Math.max(peak, active); await hold.promise; active--; };
    const first = withLocalHarnessSlot(work);
    const second = withLocalHarnessSlot(work);
    const abort = new AbortController();
    const cancelledWork = vi.fn(async () => {});
    const cancelled = withLocalHarnessSlot(cancelledWork, abort.signal);
    const rejected = expect(cancelled).rejects.toThrow("Cancelled");
    abort.abort(new Error("Cancelled"));
    await rejected;
    const lastWork = vi.fn(work);
    const last = withLocalHarnessSlot(lastWork);
    expect(lastWork).not.toHaveBeenCalled();
    hold.resolve();
    await Promise.all([first, second, last]);
    expect(peak).toBe(2);
    expect(lastWork).toHaveBeenCalledOnce();
    expect(cancelledWork).not.toHaveBeenCalled();
    await expect(withLocalHarnessSlot(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(withLocalHarnessSlot(async () => "next")).resolves.toBe("next");
  });
  it("rejects cloud-only features before starting a local process", () => {
    for (const capability of [{ hasAttachments: true }, { computerEnvironmentId: "image" }, { builtInToolIds: ["browser"] }, { browserToolPolicy: {} }]) {
      expect(() => assertLocalHarnessCapabilities(capability)).toThrow(/cloud computer features/);
    }
    expect(() => assertLocalHarnessCapabilities({})).not.toThrow();
  });
});
