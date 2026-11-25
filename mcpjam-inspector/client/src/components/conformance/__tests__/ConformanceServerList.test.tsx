import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ConformanceRunListItem } from "../ConformanceHistory";
import { ConformanceServerList } from "../ConformanceServerList";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("convex/react", () => ({ useQuery }));

vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: async (_name: string, protocolVersion: string) => ({
    status: "ready",
    protocolVersion,
  }),
}));

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

function server(name: string): ServerWithName {
  return {
    name,
    config: { url: "https://example.test" },
    connectionStatus: "connected",
    lastConnectionTime: new Date(),
    enabled: true,
    retryCount: 0,
  };
}

describe("ConformanceServerList", () => {
  it("shows each card's selected revision and runs that revision when it has no history", async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    const onViewRun = vi.fn();
    const newest = run();
    const older = {
      ...newest,
      _id: "run_older",
      protocolVersion: "2025-03-26",
      score: 42,
    };
    const beta = {
      ...newest,
      _id: "run_beta",
      targetKey: "server:srv_2",
      serverId: "srv_2",
    };
    const runs = [
      { server: server("draw"), run: newest },
      { server: server("echo"), run: beta },
    ];
    useQuery.mockImplementation((_query, args) => {
      if (args === "skip" || args.protocolVersion === "2025-06-18")
        return undefined;
      return { page: [older] };
    });
    const props = { runs, onRun, onViewRun, onSetup: vi.fn() };
    const { rerender } = render(<ConformanceServerList {...props} />);
    const [draw, echo] = screen.getAllByRole("listitem");
    const picker = within(draw).getByRole("combobox", {
      name: "Protocol version for draw",
    });
    expect(picker).toHaveTextContent(`Protocol · ${newest.protocolVersion}`);
    await user.click(within(draw).getByRole("button", { name: "View last run" }));
    expect(onViewRun).toHaveBeenLastCalledWith(newest._id);

    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "2025-03-26" }));
    expect(useQuery).toHaveBeenCalledWith(expect.anything(), {
      projectId: newest.projectId,
      targetKey: newest.targetKey,
      protocolVersion: "2025-03-26",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(within(draw).getByText("42%")).toBeInTheDocument();
    expect(within(echo).getByRole("combobox")).toHaveTextContent("2025-11-25");
    await user.click(within(draw).getByRole("button", { name: "View last run" }));
    expect(onViewRun).toHaveBeenLastCalledWith(older._id);

    await user.click(picker);
    await user.click(screen.getByRole("option", { name: "2025-06-18" }));
    expect(within(draw).getByRole("status")).toHaveTextContent(
      "Loading latest run",
    );
    expect(within(draw).getByRole("button", { name: "Run draw" })).toBeDisabled();
    expect(
      within(draw).queryByRole("button", { name: "View last run" }),
    ).toBeNull();
    useQuery.mockImplementation((_query, args) =>
      args === "skip" ? undefined : { page: [] },
    );
    rerender(<ConformanceServerList {...props} />);
    expect(within(draw).getByRole("status")).toHaveTextContent(
      "Clients can connect on any version your server supports. Run this one to make sure it passes too.",
    );
    await user.click(within(draw).getByRole("button", { name: "Run draw" }));
    expect(onRun).toHaveBeenCalledWith(
      "draw",
      "2025-06-18",
      "2025-06-18",
      "2025-11-25",
    );
    expect(
      within(echo).getByRole("button", { name: "View last run" }),
    ).toBeVisible();
    useQuery.mockReset();
  });

  it("shows scored suites as fractions and leaves out a suite that did not run", () => {
    render(
      <ConformanceServerList
        runs={[{ server: server("draw"), run: run() }]}
        onViewRun={vi.fn()}
        onRun={vi.fn()}
        onSetup={vi.fn()}
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

  it("keeps the last run time current while the card stays open", () => {
    vi.useFakeTimers();
    try {
      render(
        <ConformanceServerList
          runs={[{ server: server("draw"), run: run() }]}
          onViewRun={vi.fn()}
          onRun={vi.fn()}
          onSetup={vi.fn()}
        />,
      );
      expect(screen.getByText("Last run just now")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3 * 60_000);
      });
      expect(screen.getByText("Last run 3m ago")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
