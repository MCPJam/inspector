import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConformanceRunListItem } from "../ConformanceHistory";
import { ConformanceServerList } from "../ConformanceServerList";

vi.mock("@/lib/artifact-urls", () => ({
  useArtifactQuery: () => ({
    reports: [
      {
        suiteKind: "protocol",
        status: "completed",
        score: 92.8,
        applicable: 14,
        passed: 13,
      },
      {
        suiteKind: "apps",
        status: "completed",
        score: 100,
        applicable: 7,
        passed: 7,
      },
      {
        suiteKind: "oauth",
        status: "skipped",
        score: null,
        applicable: 0,
        passed: 0,
      },
    ],
  }),
}));

function run(): ConformanceRunListItem {
  return {
    _id: "run_1",
    projectId: "proj_1",
    targetKind: "server",
    targetKey: "server:srv_1",
    serverId: "srv_1",
    source: "ui",
    verification: "mcpjam_verified",
    status: "completed",
    outcome: "failed",
    incompleteReason: null,
    score: 90.4,
    applicable: 21,
    passed: 19,
    failed: 2,
    couldNotRun: 0,
    requestedSuites: ["protocol", "apps", "oauth"],
    protocolVersion: "2025-11-25",
    actorLabel: null,
    ciMetadata: null,
    createdAt: Date.now(),
    completedAt: null,
    durationMs: null,
    sharingEnabled: false,
  };
}

describe("ConformanceServerList", () => {
  it("shows scored suites as fractions and leaves out a suite that did not run", () => {
    render(
      <ConformanceServerList
        runs={[{ serverName: "draw", run: run() }]}
        onViewRun={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(screen.getByText("13/14")).toBeInTheDocument();
    expect(screen.getByText("7/7")).toBeInTheDocument();
    expect(screen.queryByText("OAuth")).toBeNull();
    expect(screen.queryByText("19/21")).toBeNull();
    expect(screen.getByRole("group", { name: "draw suites" })).toHaveClass(
      "min-h-[6.875rem]",
    );
  });
});
