import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { TraceRepairBanner } from "../trace-repair-banner";

describe("TraceRepairBanner", () => {
  it("shows a clear message when the job stopped with nothing to repair", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="suite"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "suite",
          stopReason: "stopped_nothing_to_repair",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(
        /Auto fix had nothing to change because there were no failing cases/i,
      ),
    ).toBeInTheDocument();
  });

  it("suite: explains stopped_no_progress as verification without promotion", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="suite"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "suite",
          stopReason: "stopped_no_progress",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(
        /Auto fix stopped without enough verified progress to promote changes or replay the suite/i,
      ),
    ).toBeInTheDocument();
  });

  it("suite: explains stopped_generation_error as generation failure before verification", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="suite"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "suite",
          stopReason: "stopped_generation_error",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(
        /Auto fix could not produce a usable repair candidate, so verification and replay never started/i,
      ),
    ).toBeInTheDocument();
  });

  it("case: explains stopped_no_progress without implying no LLM ran", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="case"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "case",
          stopReason: "stopped_no_progress",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(
        /Auto fix could not confirm enough verified progress to lock in a repair or a likely server fault for this case/i,
      ),
    ).toBeInTheDocument();
  });

  it("case: explains stopped_generation_error without implying verification ran", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="case"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "case",
          stopReason: "stopped_generation_error",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(
        /Auto fix could not produce a usable repair candidate, so verification never started/i,
      ),
    ).toBeInTheDocument();
  });

  it("appends lastError to the terminal sentence", () => {
    renderWithProviders(
      <TraceRepairBanner
        scope="suite"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-1",
          status: "failed",
          phase: "finalizing",
          scope: "suite",
          stopReason: "stopped_generation_error",
          lastError: "Field name $schema is reserved.",
          provisionalAppliedCount: 0,
          durableFixCount: 0,
          regressedCount: 0,
          serverLikelyCount: 0,
        }}
        showTerminalOutcome
      />,
    );

    expect(
      screen.getByText(/— Field name \$schema is reserved\./i),
    ).toBeInTheDocument();
  });

  it("active suite banner shows a single status sentence and Stop", () => {
    const onStop = vi.fn();
    renderWithProviders(
      <TraceRepairBanner
        scope="suite"
        activeView={{
          jobId: "job-1",
          status: "running",
          phase: "repairing",
          scope: "suite",
          currentCaseKey: undefined,
          activeCaseKeys: [],
          provisionalAppliedCount: 2,
          promisingCount: 1,
        }}
        caseTitleByKey={{}}
        onStop={onStop}
      />,
    );

    expect(screen.getByText("Auto fix")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Auto fix is generating and verifying repairs for the suite, with 2 provisional changes applied so far and 1 case still in flight/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stop/i })).toBeInTheDocument();
  });
});
