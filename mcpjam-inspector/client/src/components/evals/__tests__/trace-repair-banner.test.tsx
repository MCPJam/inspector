import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
      screen.getByText(/No failed cases on this run for trace repair/i),
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
        /Trace repair ran, but no candidate produced enough verified progress to promote or replay/i,
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
        /Trace repair generation ran, but no usable repair candidate JSON was produced, so verification and replay never started/i,
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
        /Trace repair ran, but no candidate produced enough verified progress to confirm a repair or a likely server fault/i,
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
        /Trace repair generation ran, but no usable repair candidate JSON was produced, so verification never started/i,
      ),
    ).toBeInTheDocument();
  });

  it("shows Copy JSON when trace repair copy debug is enabled and data is loaded", () => {
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
        traceRepairCopyDebug
        traceRepairDebugJson={{ job: { _id: "job-1" }, sessions: [] }}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Copy JSON/i }),
    ).toBeInTheDocument();
  });

  it("active suite banner copies debug bundle JSON to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    const bundle = { job: { _id: "job-1" }, sessions: [{ _id: "s1" }] };

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
        }}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        traceRepairCopyDebug
        traceRepairDebugJson={bundle}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Copy JSON/i }));

    expect(writeText).toHaveBeenCalledWith(JSON.stringify(bundle, null, 2));
  });

  it("case terminal banner copies JSON when copy debug is on", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    const bundle = { job: { _id: "job-case" }, sessions: [] };

    renderWithProviders(
      <TraceRepairBanner
        scope="case"
        activeView={null}
        caseTitleByKey={{}}
        onStop={vi.fn()}
        latestOutcome={{
          jobId: "job-case",
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
        traceRepairCopyDebug
        traceRepairDebugJson={bundle}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Copy JSON/i }));
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(bundle, null, 2));
  });
});
