import { describe, expect, it } from "vitest";
import {
  currentPluginRequestTimings,
  timedPluginStep,
  withPluginRequestTimings,
} from "../timing.js";

describe("plugin request step timings", () => {
  it("aggregates spans per request and never leaks across requests", async () => {
    const summary = await withPluginRequestTimings(async (timings) => {
      await timedPluginStep("tools-list", async () => {});
      await timedPluginStep("tools-list", async () => {});
      await expect(
        timedPluginStep("tool-call", async () => {
          throw new Error("failed");
        }),
      ).rejects.toThrow("failed");
      expect(timings.serverTiming()).toMatch(
        /^tools-list;dur=[\d.]+;desc="x2", tool-call;dur=[\d.]+;desc="x1", total;dur=[\d.]+$/,
      );
      return timings.summary();
    });
    expect(Object.keys(summary)).toEqual(["tools-list", "tool-call"]);
    expect(summary["tools-list"].count).toBe(2);
    expect(currentPluginRequestTimings()).toBeUndefined();
    // Outside a request the step simply runs.
    await expect(timedPluginStep("x", async () => 7)).resolves.toBe(7);
  });
});
