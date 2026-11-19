import { describe, expect, it, vi } from "vitest";
import {
  markBoxPreparationSettled,
  preparationWakeEnabled,
  waitForBoxPreparation,
} from "../box-preparation-signal.js";

describe("waitForBoxPreparation", () => {
  it("ends as soon as the box's preparation settles", async () => {
    vi.useFakeTimers();
    try {
      let woke = false;
      const waiting = waitForBoxPreparation("box-a", 4_000).then(() => {
        woke = true;
      });
      await vi.advanceTimersByTimeAsync(300);
      expect(woke).toBe(false);
      markBoxPreparationSettled("box-a");
      await waiting;
      expect(woke).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns at once after a recent settle, and waits the full pause for another box", async () => {
    markBoxPreparationSettled("box-b", 10_000);
    await expect(waitForBoxPreparation("box-b", 4_000, undefined, 12_000)).resolves.toBeUndefined();
    vi.useFakeTimers();
    try {
      let woke = false;
      const waiting = waitForBoxPreparation("box-c", 1_000).then(() => {
        woke = true;
      });
      markBoxPreparationSettled("box-b");
      await vi.advanceTimersByTimeAsync(999);
      expect(woke).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(woke).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the turn is cancelled", async () => {
    const controller = new AbortController();
    const waiting = waitForBoxPreparation("box-d", 60_000, controller.signal);
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });

  it("is off unless switched on", () => {
    expect(preparationWakeEnabled({})).toBe(false);
    expect(preparationWakeEnabled({ MCPJAM_HARNESS_PREP_WAKE: "1" })).toBe(true);
  });
});
