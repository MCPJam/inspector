import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RunOverview } from "../run-overview";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
  useQuery: () => undefined,
}));

const baseRun = {
  _id: "run-1",
  suiteId: "suite-1",
  createdBy: "u1",
  runNumber: 1,
  configRevision: "1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed" as const,
  source: "ui" as const,
  hasServerReplayConfig: true,
  createdAt: Date.now(),
  completedAt: Date.now(),
};

const baseSuite = { _id: "suite-1", name: "Suite", source: "ui" as const };

describe("RunOverview canDeleteRuns", () => {
  const baseProps = {
    suite: baseSuite,
    runs: [baseRun],
    runsLoading: false,
    allIterations: [] as any[],
    runTrendData: [] as any[],
    modelStats: [] as any[],
    onRunClick: vi.fn(),
    onDirectDeleteRun: vi.fn(),
    runsViewMode: "runs" as const,
    onViewModeChange: vi.fn(),
  };

  it("shows per-run selection checkboxes when canDeleteRuns is true", () => {
    renderWithProviders(<RunOverview {...baseProps} canDeleteRuns />);
    expect(
      screen.getByRole("checkbox", { name: /Select run/i }),
    ).toBeInTheDocument();
  });

  it("hides per-run selection checkboxes when canDeleteRuns is false", () => {
    renderWithProviders(<RunOverview {...baseProps} canDeleteRuns={false} />);
    expect(
      screen.queryByRole("checkbox", { name: /Select run/i }),
    ).not.toBeInTheDocument();
  });

  it("shows Delete suite control when canDeleteSuite and handler are set", async () => {
    const user = userEvent.setup();
    const onDeleteSuite = vi.fn();

    renderWithProviders(
      <RunOverview
        {...baseProps}
        canDeleteRuns={false}
        canDeleteSuite
        onDeleteSuite={onDeleteSuite}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete suite" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDeleteSuite).toHaveBeenCalledTimes(1);
  });

  it("hides Delete suite when canDeleteSuite is false", () => {
    renderWithProviders(
      <RunOverview
        {...baseProps}
        canDeleteSuite={false}
        onDeleteSuite={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Delete suite" }),
    ).not.toBeInTheDocument();
  });

  it("disables batch delete while the selection holds a run it cannot delete", async () => {
    const user = userEvent.setup();
    const theirs = { ...baseRun, _id: "run-2", runNumber: 2, createdBy: "u2" };

    renderWithProviders(
      <RunOverview
        {...baseProps}
        runs={[baseRun, theirs]}
        canDeleteRuns
        canDeleteRun={(run) => run.createdBy === "u1"}
      />,
    );

    const [mine, notMine] = screen.getAllByRole("checkbox", {
      name: /Select run/i,
    });

    await user.click(mine);
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();

    // Adding someone else's run disables the action rather than quietly
    // deleting the half of the selection it is allowed to.
    await user.click(notMine);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("leaves batch delete enabled when no per-run predicate is supplied", () => {
    // The local/playground case: no membership to rank, so every run goes.
    renderWithProviders(
      <RunOverview {...baseProps} runs={[baseRun]} canDeleteRuns />,
    );
    expect(
      screen.getByRole("checkbox", { name: /Select run/i }),
    ).toBeInTheDocument();
  });

  it("hides the Runs/Cases selector when hideViewModeSelect is set", () => {
    renderWithProviders(<RunOverview {...baseProps} hideViewModeSelect />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("RunOverview run-by provenance", () => {
  const baseProps = {
    suite: baseSuite,
    runsLoading: false,
    allIterations: [] as any[],
    runTrendData: [] as any[],
    modelStats: [] as any[],
    onRunClick: vi.fn(),
    onDirectDeleteRun: vi.fn(),
    runsViewMode: "runs" as const,
    onViewModeChange: vi.fn(),
  };

  const automatedRun = {
    ...baseRun,
    source: "api" as const,
    attribution: { surface: "rest", apiKeyId: "key_abcd3f9a" },
  };

  it("names the credential even when the creator cannot be resolved", async () => {
    const user = userEvent.setup();
    // No `userMap` at all — a member who left, or a map that has not loaded.
    // This is the case where knowing the credential matters MOST: nobody is
    // going to recognise the run from the avatar. Nesting the label under the
    // resolved-creator branch meant the automated runs were exactly the ones
    // that showed nothing.
    renderWithProviders(<RunOverview {...baseProps} runs={[automatedRun]} />);

    await user.hover(screen.getByText("?"));
    // `findAllBy`: Radix mirrors tooltip content into an aria live region, so
    // the label legitimately appears twice.
    expect(
      (await screen.findAllByText("via API key ····3f9a")).length,
    ).toBeGreaterThan(0);
  });

  it("names the calling agent for a Slack-attributed MCP run", async () => {
    const user = userEvent.setup();
    // `resolveRunOrigin` answers `slack` here, not `mcp`. Keying the agent
    // name off the resolved origin hid it for every run launched through the
    // Slack and Discord agents — the ones that have a name to show.
    renderWithProviders(
      <RunOverview
        {...baseProps}
        runs={[
          {
            ...automatedRun,
            launcher: { kind: "mcp", client: "mcpjam-slack/2.0.0" },
            attribution: { surface: "slack", apiKeyId: "key_abcd3f9a" },
          },
        ]}
      />,
    );

    await user.hover(screen.getByText("?"));
    expect(
      (await screen.findAllByText("via mcpjam-slack/2.0.0")).length,
    ).toBeGreaterThan(0);
  });

  it("says nothing extra for an app run with no resolvable creator", async () => {
    renderWithProviders(<RunOverview {...baseProps} runs={[baseRun]} />);

    // No creator and no credential: the bare placeholder, as before. The fix
    // must not turn every unknown avatar into an empty tooltip.
    expect(screen.getByText("?")).toBeInTheDocument();
    expect(screen.queryByText(/^via /)).toBeNull();
  });
});
