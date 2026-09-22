import { describe, expect, it } from "vitest";
import {
  TRACE_TIMELINE_FILTERS,
  timelineFilterLabel,
  type TimelineFilter,
} from "../recorded-trace-toolbar";

describe("recorded-trace toolbar filters", () => {
  it("includes connection and discovery and labels every entry", () => {
    expect(TRACE_TIMELINE_FILTERS).toEqual([
      "all",
      "connection",
      "discovery",
      "llm",
      "tool",
      "error",
    ]);
    for (const entry of TRACE_TIMELINE_FILTERS) {
      expect(timelineFilterLabel(entry).length).toBeGreaterThan(0);
    }
    expect(timelineFilterLabel("connection")).toBe("Connect");
    expect(timelineFilterLabel("discovery")).toBe("Discovery");
  });

  it("does not treat empty, null, or unknown values as known filters", () => {
    const known = new Set<string>(TRACE_TIMELINE_FILTERS);
    for (const value of ["", null, undefined, "handshake", "step"]) {
      expect(known.has(value as TimelineFilter)).toBe(false);
    }
  });
});
