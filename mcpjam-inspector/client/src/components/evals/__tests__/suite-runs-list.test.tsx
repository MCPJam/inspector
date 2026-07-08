/**
 * suite-runs-list.tsx tests
 *
 * Covers V1 run-group UI behavior:
 *  - Mixed grouped + ungrouped runs render parents + standalones.
 *  - Parent row aggregate Acc is the mean of children's *effective* pass
 *    rates (live-iteration-derived, not `summary`-derived).
 *  - Single-host launches (no `runGroupId`) render ungrouped just like
 *    legacy rows — no chevron, no aggregate row.
 */
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import {
  SuiteRunsList,
  computeEffectiveRunResult,
  computeRunEffectiveStats,
} from "../suite-runs-list";
import type { EvalIteration, EvalSuiteRun } from "../types";

// The SuiteRunsList renders an Avatar/Tooltip from the design system; jsdom
// does not need any mocking for those — they degrade gracefully without
// portals. HostChip also renders fine without provider mocks.

function makeRun(overrides: Partial<EvalSuiteRun>): EvalSuiteRun {
  return {
    _id: "run-default",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: ["server-1"] },
    },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
    ...overrides,
  } as EvalSuiteRun;
}

// Build an iteration shaped just enough for `computeIterationResult` to
// short-circuit on `resultSource === "reported"` and return the recorded
// `result`. We rely on the live-iteration path here so the test exercises
// the same code that drives the dashboard during a streaming run.
function makeIteration(
  suiteRunId: string,
  result: "passed" | "failed",
  id: string,
): EvalIteration {
  return {
    _id: id,
    suiteRunId,
    status: "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    testCaseSnapshot: { expectedToolCalls: [] },
  } as unknown as EvalIteration;
}

describe("SuiteRunsList run-group rendering", () => {
  it("renders one parent row per multi-run group and standalone rows for ungrouped runs", () => {
    const runs: EvalSuiteRun[] = [
      makeRun({
        _id: "ga1xxxxx",
        runGroupId: "group-a",
        namedHostId: "host-mcpjam",
        createdAt: 10_000,
        completedAt: 12_000,
      }),
      makeRun({
        _id: "ga2xxxxx",
        runGroupId: "group-a",
        namedHostId: "host-claude",
        createdAt: 11_000,
        completedAt: 13_000,
      }),
      makeRun({
        _id: "legacy0yyyy",
        // No runGroupId → standalone.
        createdAt: 5_000,
        completedAt: 6_000,
      }),
    ];

    renderWithProviders(
      <SuiteRunsList
        runs={runs}
        allIterations={[]}
        onRunClick={vi.fn()}
      />,
    );

    // Parent row visible.
    expect(screen.getByText(/Run group g/i)).toBeInTheDocument();
    expect(screen.getByText(/2 hosts/i)).toBeInTheDocument();

    // Children NOT visible until expanded — assert by run id label.
    expect(
      screen.queryByLabelText(/Open run ga[12]/i),
    ).not.toBeInTheDocument();

    // The legacy standalone row IS visible and looks unchanged (no
    // chevron, opens directly on click).
    expect(
      screen.getByLabelText(/Open run legacy0/i),
    ).toBeInTheDocument();
  });

  it("parent aggregate Acc equals the mean of children's effective pass rates (live-iteration source)", () => {
    // Two grouped runs. Each has 4 iterations: host-a passes 4/4
    // (100%), host-b passes 1/4 (25%). Mean = 62 (rounded). Crucially,
    // both runs' `summary` is left empty so we can prove the parent is
    // reading the live-iteration path, not run.summary.
    const runs: EvalSuiteRun[] = [
      makeRun({
        _id: "run-host-a",
        runGroupId: "g-mean",
        namedHostId: "host-a",
        status: "running",
        // No summary on purpose.
        summary: undefined,
        createdAt: 10_000,
        completedAt: undefined,
      }),
      makeRun({
        _id: "run-host-b",
        runGroupId: "g-mean",
        namedHostId: "host-b",
        status: "running",
        summary: undefined,
        createdAt: 10_500,
        completedAt: undefined,
      }),
    ];

    const iterations: EvalIteration[] = [
      makeIteration("run-host-a", "passed", "ita1"),
      makeIteration("run-host-a", "passed", "ita2"),
      makeIteration("run-host-a", "passed", "ita3"),
      makeIteration("run-host-a", "passed", "ita4"),
      makeIteration("run-host-b", "passed", "itb1"),
      makeIteration("run-host-b", "failed", "itb2"),
      makeIteration("run-host-b", "failed", "itb3"),
      makeIteration("run-host-b", "failed", "itb4"),
    ];

    // Sanity: confirm the helper agrees with what we expect for each
    // child. This pins the source of the aggregate to the helper, not
    // to anything that could regress to `run.summary`.
    const aStats = computeRunEffectiveStats(
      runs[0],
      iterations.filter((i) => i.suiteRunId === "run-host-a"),
    );
    const bStats = computeRunEffectiveStats(
      runs[1],
      iterations.filter((i) => i.suiteRunId === "run-host-b"),
    );
    expect(aStats.passRate).toBe(100);
    expect(bStats.passRate).toBe(25);

    renderWithProviders(
      <SuiteRunsList
        runs={runs}
        allIterations={iterations}
        onRunClick={vi.fn()}
      />,
    );

    // Expected mean: round((100 + 25) / 2) = 63.
    expect(screen.getByText("63%")).toBeInTheDocument();
  });

  it("renders a single-host launch (no runGroupId) as an ungrouped standalone row identical to legacy", () => {
    const run = makeRun({
      _id: "solo0xxx",
      // No runGroupId at all — this is what use-eval-handlers emits for
      // single-host launches.
    });

    renderWithProviders(
      <SuiteRunsList runs={[run]} allIterations={[]} onRunClick={vi.fn()} />,
    );

    // Standalone row visible.
    expect(
      screen.getByLabelText(/Open run solo0/i),
    ).toBeInTheDocument();

    // No parent row markers at all.
    expect(screen.queryByText(/Run group g/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/hosts/i)).not.toBeInTheDocument();
  });

  it("shows cancelled directly on standalone run rows", () => {
    const run = makeRun({
      _id: "cancelled0",
      status: "cancelled",
      result: "cancelled",
      completedAt: 2_000,
    });

    renderWithProviders(
      <SuiteRunsList runs={[run]} allIterations={[]} onRunClick={vi.fn()} />,
    );

    expect(screen.getByLabelText(/Open run cancelle/i)).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("shows cancelled directly on run group rows", () => {
    const runs: EvalSuiteRun[] = [
      makeRun({
        _id: "cancelAaa",
        runGroupId: "g-cancel",
        namedHostId: "host-a",
        status: "cancelled",
        result: "cancelled",
      }),
      makeRun({
        _id: "cancelBbb",
        runGroupId: "g-cancel",
        namedHostId: "host-b",
        status: "cancelled",
        result: "cancelled",
      }),
    ];

    renderWithProviders(
      <SuiteRunsList runs={runs} allIterations={[]} onRunClick={vi.fn()} />,
    );

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("expanding a group reveals its child runs", async () => {
    const user = userEvent.setup();
    const runs: EvalSuiteRun[] = [
      makeRun({
        _id: "expandAaa",
        runGroupId: "g-expand",
        namedHostId: "host-a",
      }),
      makeRun({
        _id: "expandBbb",
        runGroupId: "g-expand",
        namedHostId: "host-b",
      }),
    ];

    renderWithProviders(
      <SuiteRunsList runs={runs} allIterations={[]} onRunClick={vi.fn()} />,
    );

    // Children hidden initially.
    expect(
      screen.queryByLabelText(/Open run expandA/i),
    ).not.toBeInTheDocument();

    const expander = screen.getByRole("button", {
      name: /Expand run group g/i,
    });
    await user.click(expander);

    // Both children now visible.
    expect(
      screen.getByLabelText(/Open run expandA/i),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Open run expandB/i),
    ).toBeInTheDocument();
  });

  it("parent group renders failed accent when a completed child is below passCriteria even with no run.result", async () => {
    // Regression for the cursor/codex review finding: the recorder finalizes
    // runs as `status: completed` + `summary` without always setting
    // `result: "failed"`. Children derive failed-ness from passRate vs
    // passCriteria; the parent must use the same source or it would show
    // a green border over a red child.
    const passingChild = makeRun({
      _id: "gfail1xx",
      runGroupId: "g-fail",
      namedHostId: "host-pass",
      status: "completed",
      result: undefined,
      summary: { total: 2, passed: 2, failed: 0, passRate: 100 },
      passCriteria: { minimumPassRate: 80 },
    });
    const failingChild = makeRun({
      _id: "gfail2xx",
      runGroupId: "g-fail",
      namedHostId: "host-fail",
      status: "completed",
      result: undefined,
      summary: { total: 4, passed: 1, failed: 3, passRate: 25 },
      passCriteria: { minimumPassRate: 80 },
    });

    const { container } = renderWithProviders(
      <SuiteRunsList
        runs={[passingChild, failingChild]}
        allIterations={[]}
        onRunClick={vi.fn()}
      />,
    );

    const parentButton = screen.getByLabelText(/Expand run group g/i);
    // Wrapper div carries the left-border accent class.
    const accent = parentButton.closest("[class*='border-l-2']");
    expect(accent).not.toBeNull();
    expect(accent!.className).toContain("border-l-destructive");
    expect(accent!.className).not.toContain("border-l-success");
  });

  it("renders a group with only one settled child as a standalone (no chevron) during the partial-fan-out gap", () => {
    // If Convex sync briefly returns only one run with a given group id,
    // showing a parent labelled "1 hosts" would look broken. The
    // component degrades to a standalone row until the sibling appears.
    const run = makeRun({
      _id: "partial0",
      runGroupId: "g-partial",
      namedHostId: "host-a",
    });

    renderWithProviders(
      <SuiteRunsList runs={[run]} allIterations={[]} onRunClick={vi.fn()} />,
    );

    expect(screen.queryByText(/Run group g/i)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(/Open run partial0/i),
    ).toBeInTheDocument();
  });
});

describe("computeRunEffectiveStats", () => {
  it("uses live iterations once any have terminated, ignoring run.summary", () => {
    const run = makeRun({
      _id: "r1",
      // summary says 0/0 — must be overridden by live iterations.
      summary: { total: 99, passed: 99, failed: 0, passRate: 100 },
    });
    const stats = computeRunEffectiveStats(run, [
      makeIteration("r1", "passed", "a"),
      makeIteration("r1", "failed", "b"),
    ]);
    expect(stats.passRate).toBe(50);
  });

  it("falls back to run.summary when no iterations are observable yet", () => {
    const run = makeRun({
      _id: "r2",
      summary: { total: 4, passed: 3, failed: 1, passRate: 75 },
    });
    const stats = computeRunEffectiveStats(run, []);
    expect(stats.passRate).toBe(75);
  });

  it("returns null when neither iterations nor summary are usable", () => {
    const run = makeRun({ _id: "r3", summary: undefined });
    const stats = computeRunEffectiveStats(run, []);
    expect(stats.passRate).toBeNull();
  });
});

describe("computeEffectiveRunResult", () => {
  it("prefers explicit run.result when set", () => {
    const run = makeRun({ result: "failed", status: "completed" });
    expect(computeEffectiveRunResult(run, 100)).toBe("failed");
  });

  it("derives failed from passRate below passCriteria when result is unset", () => {
    const run = makeRun({
      result: undefined,
      status: "completed",
      passCriteria: { minimumPassRate: 80 },
    });
    expect(computeEffectiveRunResult(run, 25)).toBe("failed");
  });

  it("derives passed from passRate at-or-above passCriteria when result is unset", () => {
    const run = makeRun({
      result: undefined,
      status: "completed",
      passCriteria: { minimumPassRate: 80 },
    });
    expect(computeEffectiveRunResult(run, 80)).toBe("passed");
  });

  it("defaults minimumPassRate to 100 when passCriteria is absent", () => {
    const run = makeRun({
      result: undefined,
      status: "completed",
      passCriteria: undefined,
    });
    expect(computeEffectiveRunResult(run, 99)).toBe("failed");
    expect(computeEffectiveRunResult(run, 100)).toBe("passed");
  });

  it("returns running/cancelled/pending based on status when passRate is null", () => {
    expect(
      computeEffectiveRunResult(
        makeRun({ result: undefined, status: "running" }),
        null,
      ),
    ).toBe("running");
    expect(
      computeEffectiveRunResult(
        makeRun({ result: undefined, status: "cancelled" }),
        null,
      ),
    ).toBe("cancelled");
    expect(
      computeEffectiveRunResult(
        makeRun({ result: undefined, status: "completed" }),
        null,
      ),
    ).toBe("pending");
  });
});
