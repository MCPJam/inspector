import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { useConformanceRun } from "@/hooks/use-conformance-run";
import {
  PersistConformanceRun,
  shouldStartPersistedRun,
} from "../PersistConformanceRun";

const { startRun, heartbeat, finalizeRun, upsertReport } = vi.hoisted(() => ({
  startRun: vi.fn().mockResolvedValue({ runId: "run_1" }),
  heartbeat: vi.fn().mockResolvedValue(undefined),
  finalizeRun: vi.fn().mockResolvedValue(undefined),
  upsertReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "conformanceRuns:startRun") return startRun;
    if (name === "conformanceRuns:heartbeat") return heartbeat;
    if (name === "conformanceRuns:finalizeRun") return finalizeRun;
    return vi.fn();
  },
  useAction: (name: string) => {
    if (name === "conformanceRuns:upsertReportAction") return upsertReport;
    return vi.fn();
  },
}));

type RunSnapshot = ReturnType<typeof useConformanceRun>;

function idleSuite() {
  return { status: "idle" as const };
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    protocol: idleSuite(),
    apps: idleSuite(),
    tasks: idleSuite(),
    oauth: idleSuite(),
    versionPin: "auto",
    setVersionPin: vi.fn(),
    runVersion: 0,
    runAll: vi.fn(),
    authorizeOAuth: vi.fn(),
    oauthNotScored: false,
    isRunning: false,
    ...overrides,
  };
}

function httpServer(): ServerWithName {
  return {
    name: "amazon",
    lastConnectionTime: new Date(),
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    config: {
      url: "https://example.com/mcp",
      timeout: 30000,
    },
  };
}

function renderPersist(run: RunSnapshot) {
  return render(
    <PersistConformanceRun
      persist={{ projectId: "proj_1", serverId: "srv_1" }}
      server={httpServer()}
      snapshot={run}
    />,
  );
}

describe("shouldStartPersistedRun", () => {
  it("ignores the unused initial version", () => {
    expect(
      shouldStartPersistedRun({
        runVersion: 0,
        startedVersion: 0,
        isExecuting: true,
      }),
    ).toBe(false);
  });

  it("ignores an idle resetStates bump", () => {
    expect(
      shouldStartPersistedRun({
        runVersion: 1,
        startedVersion: 0,
        isExecuting: false,
      }),
    ).toBe(false);
  });

  it("starts once when suites actually begin", () => {
    expect(
      shouldStartPersistedRun({
        runVersion: 2,
        startedVersion: 0,
        isExecuting: true,
      }),
    ).toBe(true);
  });

  it("does not open a second row for the same attempt", () => {
    expect(
      shouldStartPersistedRun({
        runVersion: 2,
        startedVersion: 2,
        isExecuting: true,
      }),
    ).toBe(false);
  });
});

describe("PersistConformanceRun", () => {
  beforeEach(() => {
    startRun.mockClear();
    heartbeat.mockClear();
    finalizeRun.mockClear();
    upsertReport.mockClear();
  });

  it("does not persist the idle mount reset", async () => {
    renderPersist(snapshot({ runVersion: 1, isRunning: false }));

    await waitFor(() => expect(startRun).not.toHaveBeenCalled());
  });

  it("does not persist when a remount repeats the idle bump", async () => {
    const { rerender } = renderPersist(
      snapshot({ runVersion: 1, isRunning: false }),
    );
    rerender(
      <PersistConformanceRun
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
        server={httpServer()}
        snapshot={snapshot({ runVersion: 1, isRunning: false })}
      />,
    );

    await waitFor(() => expect(startRun).not.toHaveBeenCalled());
  });

  it("persists once when the operator starts suites", async () => {
    const { rerender } = renderPersist(
      snapshot({ runVersion: 1, isRunning: false }),
    );
    rerender(
      <PersistConformanceRun
        persist={{ projectId: "proj_1", serverId: "srv_1" }}
        server={httpServer()}
        snapshot={snapshot({
          runVersion: 2,
          isRunning: true,
          protocol: { status: "running" },
        })}
      />,
    );

    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(1));
    expect(startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        source: "ui",
        actorLabel: "Inspector UI",
      }),
    );
  });
});
