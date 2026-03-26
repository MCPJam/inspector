import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteHeroStats } from "../suite-hero-stats";
import { RunAccordionView } from "../run-accordion-view";

describe("CI replay actions", () => {
  const replayableRun = {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: ["asana"] },
    },
    status: "completed" as const,
    source: "sdk" as const,
    hasServerReplayConfig: true,
    createdAt: 1,
  };

  it("shows replay latest run in the suite hero card", async () => {
    const onReplayLatestRun = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <SuiteHeroStats
        runs={[replayableRun]}
        allIterations={[
          {
            _id: "iter-1",
            suiteRunId: "run-1",
            createdBy: "user-1",
            createdAt: 1,
            iterationNumber: 1,
            updatedAt: 2,
            status: "completed",
            result: "passed",
            actualToolCalls: [],
            tokensUsed: 0,
          },
        ]}
        runTrendData={[]}
        modelStats={[]}
        testCaseCount={1}
        isSDK={true}
        onReplayLatestRun={onReplayLatestRun}
      />,
    );

    const button = screen.getByRole("button", { name: "Replay latest run" });
    expect(button).toBeTruthy();

    await user.click(button);
    expect(onReplayLatestRun).toHaveBeenCalledWith(replayableRun);
  });

  it("shows replay on each replayable run row", async () => {
    const onReplayRun = vi.fn();
    const onRunClick = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <RunAccordionView
        suite={{ _id: "suite-1", name: "Asana MCP Evals", source: "sdk" }}
        runs={[replayableRun]}
        allIterations={[]}
        onRunClick={onRunClick}
        onReplayRun={onReplayRun}
      />,
    );

    const button = screen.getByRole("button", { name: "Replay" });
    expect(button).toBeTruthy();

    await user.click(button);
    expect(onReplayRun).toHaveBeenCalledWith(replayableRun);
    expect(onRunClick).not.toHaveBeenCalled();
  });
});
