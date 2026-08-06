import { describe, it, expect } from "vitest";
import {
  computeVisibleHostIconCount,
  sortReportsByHostPriority,
} from "../HostCompatStrip";
import type { HostCompatReport } from "@/lib/host-compat/types";

function makeReport(hostId: string): HostCompatReport {
  return {
    hostId,
    hostLabel: hostId,
    verdict: "works",
    provenance: "observed",
    lanes: {
      apps: { verdict: "works", provenance: "observed" },
      server: { verdict: "works", provenance: "observed" },
    },
    findings: [],
    logoSrc: "",
  };
}

describe("computeVisibleHostIconCount", () => {
  it("shows every host up to the cap when there is ample width", () => {
    expect(computeVisibleHostIconCount(1000, 5, 8)).toBe(5);
    expect(computeVisibleHostIconCount(1000, 8, 8)).toBe(8);
  });

  it("caps at the max even with unlimited width", () => {
    expect(computeVisibleHostIconCount(1000, 20, 8)).toBe(8);
  });

  it("never reports more visible icons than fit alongside the +N badge", () => {
    // 9 hosts, but only enough room for a handful of icons plus the badge.
    const visible = computeVisibleHostIconCount(120, 9, 8);
    expect(visible).toBeLessThan(8);
    expect(visible).toBeGreaterThanOrEqual(0);
  });

  it("never returns the full cap when a badge is required", () => {
    // Regression guard: undercounting hiddenReports (e.g. always showing 8)
    // is exactly the bug a narrow card exposed — the badge must shrink the
    // visible count whenever not everything fits. toBeLessThan(9) would
    // pass even for a broken constant-8 implementation, so assert against
    // the cap (8) itself, not the (irrelevant here) host total.
    for (const width of [40, 60, 80, 100, 130, 150]) {
      const visible = computeVisibleHostIconCount(width, 9, 8);
      expect(visible).toBeLessThan(8);
    }
  });

  it("shows the full cap alongside the badge when there is room for both", () => {
    // 9 hosts hits the cap of 8, so a badge for the 1 beyond-cap host is
    // unavoidable — but with ample width that badge shouldn't cost the
    // strip a visible icon it didn't need to give up.
    expect(computeVisibleHostIconCount(1000, 9, 8)).toBe(8);
  });

  it("returns 0 when there is no room even for the badge", () => {
    expect(computeVisibleHostIconCount(10, 9, 8)).toBe(0);
  });

  it("returns 0 for an empty report list regardless of width", () => {
    expect(computeVisibleHostIconCount(1000, 0, 8)).toBe(0);
  });

  it("clamps negative/zero width to no visible icons when a badge is needed", () => {
    expect(computeVisibleHostIconCount(0, 9, 8)).toBe(0);
  });
});

describe("sortReportsByHostPriority", () => {
  it("leads with agentcore, mistral, goose in that order", () => {
    const reports = [
      makeReport("cursor"),
      makeReport("goose"),
      makeReport("mistral"),
      makeReport("agentcore"),
    ];
    const order = sortReportsByHostPriority(reports).map((r) => r.hostId);
    expect(order.slice(0, 3)).toEqual(["agentcore", "mistral", "goose"]);
  });

  it("always trails with mcpjam", () => {
    const reports = [
      makeReport("mcpjam"),
      makeReport("cursor"),
      makeReport("agentcore"),
    ];
    const order = sortReportsByHostPriority(reports).map((r) => r.hostId);
    expect(order[order.length - 1]).toBe("mcpjam");
  });

  it("keeps the incoming order for hosts outside the leading/trailing set", () => {
    const reports = [
      makeReport("vscode"),
      makeReport("cursor"),
      makeReport("windsurf"),
    ];
    const order = sortReportsByHostPriority(reports).map((r) => r.hostId);
    expect(order).toEqual(["vscode", "cursor", "windsurf"]);
  });

  it("omits leading/trailing hosts that aren't present rather than inserting gaps", () => {
    const reports = [makeReport("cursor"), makeReport("mistral")];
    const order = sortReportsByHostPriority(reports).map((r) => r.hostId);
    expect(order).toEqual(["mistral", "cursor"]);
  });

  it("produces the full documented order end to end", () => {
    const reports = [
      makeReport("windsurf"),
      makeReport("mcpjam"),
      makeReport("goose"),
      makeReport("cursor"),
      makeReport("mistral"),
      makeReport("agentcore"),
    ];
    const order = sortReportsByHostPriority(reports).map((r) => r.hostId);
    expect(order).toEqual([
      "agentcore",
      "mistral",
      "goose",
      "windsurf",
      "cursor",
      "mcpjam",
    ]);
  });
});
