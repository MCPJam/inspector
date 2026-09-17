import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EvaluateRunPage,
  pairingDecision,
  useEvaluateRunPageHeaderActions,
} from "../evaluate-run-page";
import type { EvalIteration, EvalSuiteRun, EvalSuite } from "../../evals/types";

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    namedHostId: "host-1",
    summary: { total: 3, passed: 2, failed: 1, passRate: 67 },
    ...overrides,
  };
}

const hostNamesById = new Map<string, string | null>([["host-1", "Claude"]]);

describe("EvaluateRunPage", () => {
  it("uses a simple Paper header with Compare as a visible action", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "n57cvtk9tsmnbj5tpcvnmdgkwn8dnjeq" })}
        hostNamesById={hostNamesById}
        otherRuns={[makeRun({ _id: "other-run" })]}
        defaultCompareRunId="other-run"
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByTestId("evaluate-run-page")).toHaveTextContent("Run #1");
    expect(screen.getByText("run body")).toBeTruthy();
    expect(screen.queryByText("All runs")).toBeNull();
    expect(screen.queryByText("latest + trends per client")).toBeNull();
    const header = screen.getByTestId("evaluate-run-header");
    expect(within(header).getByRole("heading", { name: "Run #1" })).toHaveClass(
      "text-2xl",
      "font-bold",
      "tracking-tight",
    );
    expect(
      within(header).getByRole("heading", { name: "Run #1" }),
    ).not.toHaveClass("font-mono");
    expect(within(header).queryByText("Report for")).toBeNull();
    expect(
      within(header).queryByTestId("evaluate-run-launch-context"),
    ).toBeNull();
    const compare = screen.getByRole("button", { name: "Compare runs" });
    expect(compare).toBeVisible();
    expect(compare).not.toBeDisabled();
    expect(screen.getByTestId("evaluate-run-compare-open")).toBe(compare);
    expect(screen.queryByRole("button", { name: "Export report" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Run details" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "New run" })).toBeNull();
    expect(within(header).queryByText("Failed")).toBeNull();
    expect(within(header).queryByText("Passed")).toBeNull();
    expect(screen.queryByTestId("run-header-decision-pill")).toBeNull();
    expect(screen.queryByTestId("run-header-pairing")).toBeNull();
  });

  it.each([
    ["completed", "failed", "HOLD"],
    ["completed", "passed", "SHIP"],
    ["timed_out", "pending", "HOLD"],
    ["failed", "pending", "HOLD"],
    ["grading", "pending", "Grading"],
    ["running", "pending", "Running"],
    ["completed", "inconclusive", "Inconclusive"],
  ] as const)(
    "maps %s/%s to %s: with the logo inside that pill",
    (status, result, label) => {
      render(
        <EvaluateRunPage
          run={makeRun({ _id: "run", status, result })}
          hostNamesById={hostNamesById}
          otherRuns={[]}
          defaultCompareRunId={null}
          onCompareWithRun={vi.fn()}
        >
          body
        </EvaluateRunPage>,
      );
      const header = screen.getByTestId("evaluate-run-header");
      if (label === "HOLD" || label === "SHIP") {
        expect(
          within(header).queryByTestId("run-header-decision-pill"),
        ).toBeNull();
        return;
      }
      const pill = within(header).getByTestId("run-header-decision-pill");
      expect(pill).toHaveClass("h-8", "rounded-full");
      expect(
        within(pill).getByTestId("run-header-pairing-decision"),
      ).toHaveTextContent(label);
      const mark = within(pill).getByLabelText("Claude · Client default");
      expect(mark).toBeVisible();
      expect(mark).toHaveClass("bg-background");
      expect(mark.querySelector("img")).toBeVisible();
      expect(within(header).queryByText("Failed")).toBeNull();
      expect(within(header).queryByText("Passed")).toBeNull();
      expect(within(header).queryByTestId("run-header-verdict")).toBeNull();
    },
  );

  it("uses a stable run title and removes individual client report switching", () => {
    render(
      <EvaluateRunPage
        run={makeRun({
          _id: "current",
          runGroupId: "launch",
          effectiveModelId: "sonnet",
        })}
        hostNamesById={hostNamesById}
        otherRuns={[
          makeRun({
            _id: "sibling",
            runGroupId: "launch",
            effectiveModelId: "opus",
            result: "passed",
          }),
          makeRun({
            _id: "old",
            runGroupId: "older",
            effectiveModelId: "other",
          }),
        ]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        body
      </EvaluateRunPage>,
    );
    expect(screen.getByRole("heading", { name: "Run #1" })).toBeVisible();
    expect(screen.queryByText(/client\/model pairing/)).toBeNull();
    expect(screen.queryByTestId("run-header-pairings")).toBeNull();
    expect(screen.queryByText("HOLD")).toBeNull();
    expect(screen.queryByText("SHIP")).toBeNull();
    expect(screen.queryByRole("button", { name: /Client report/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Run details" })).toBeNull();
    expect(screen.queryByText("sonnet")).toBeNull();
    expect(screen.queryByText("opus")).toBeNull();
  });

  it("omits Hold badges for all failed pairings", () => {
    render(
      <EvaluateRunPage
        run={makeRun({
          _id: "current",
          runGroupId: "launch",
          namedHostId: "host-1",
          effectiveModelId: "sonnet",
        })}
        hostNamesById={
          new Map([
            ["host-1", "Claude"],
            ["host-2", "Cursor"],
          ])
        }
        otherRuns={[
          makeRun({
            _id: "sibling",
            runGroupId: "launch",
            namedHostId: "host-2",
            effectiveModelId: "opus",
            result: "failed",
          }),
        ]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        body
      </EvaluateRunPage>,
    );
    expect(screen.queryByTestId("run-header-pairings")).toBeNull();
    expect(screen.queryByText("HOLD")).toBeNull();
  });

  it("recovers the pairing model from iterations when the run omitted it", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "run-1", status: "running", result: "pending" })}
        iterations={
          [
            {
              suiteRunId: "run-1",
              testCaseSnapshot: { model: "anthropic/claude-haiku-4.5" },
            },
          ] as EvalIteration[]
        }
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        body
      </EvaluateRunPage>,
    );
    expect(
      within(screen.getByTestId("run-header-decision-pill")).getByLabelText(
        "Claude · claude-haiku-4.5",
      ),
    ).toBeVisible();
  });

  it("keeps launch metadata out of the header", () => {
    render(
      <EvaluateRunPage
        run={makeRun({
          _id: "n57cvtk9tsmnbj5tpcvnmdgkwn8dnjeq",
          configSnapshot: {
            tests: [],
            environment: { servers: ["Excalidraw (App)"] },
          },
        })}
        hostNamesById={hostNamesById}
        otherRuns={[makeRun({ _id: "other-run" })]}
        defaultCompareRunId="other-run"
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.queryByTestId("evaluate-run-launch-context")).toBeNull();
    expect(screen.queryByTestId("evaluate-run-servers")).toBeNull();
    expect(screen.queryByText("Excalidraw (App)")).toBeNull();
  });

  it("disables Compare when there is no other run", async () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "only-run" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    const compare = screen.getByRole("button", { name: "Compare runs" });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute("title", "Need at least two runs");
  });

  it("closes launch review when navigation selects the accepted run", async () => {
    const props = {
      hostNamesById,
      otherRuns: [],
      defaultCompareRunId: null,
      onCompareWithRun: vi.fn(),
      launchReview: {
        suite: {
          _id: "suite-1",
          name: "Suite",
          environment: { servers: [] },
        } as EvalSuite,
        cases: [],
        hostNamesById,
        onStart: vi.fn(),
      },
      children: <div>Live results</div>,
    };
    const { rerender } = render(
      <EvaluateRunPage {...props} run={makeRun({ _id: "old" })} />,
    );
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "Run again" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    rerender(
      <EvaluateRunPage
        {...props}
        run={makeRun({ _id: "accepted", status: "running" })}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Live results")).toBeVisible();
  });

  it("opens the compare picker and confirms the default other run", async () => {
    const user = userEvent.setup();
    const onCompareWithRun = vi.fn();

    render(
      <EvaluateRunPage
        run={makeRun({ _id: "this-run" })}
        hostNamesById={hostNamesById}
        otherRuns={[
          makeRun({
            _id: "prev-run",
            summary: { total: 3, passed: 2, failed: 1, passRate: 67 },
          }),
        ]}
        defaultCompareRunId="prev-run"
        onCompareWithRun={onCompareWithRun}
        onExport={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.queryByRole("button", { name: "Export report" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compare runs" }));
    expect(screen.getByTestId("evaluate-run-compare")).toBeTruthy();
    expect(screen.queryByText("run body")).toBeNull();

    await user.click(screen.getByTestId("evaluate-run-compare-confirm"));
    expect(onCompareWithRun).toHaveBeenCalledWith("prev-run");
  });

  it("keeps overflow only when header actions remain", async () => {
    function HeaderActionChild({ onImprove }: { onImprove?: () => void }) {
      useEvaluateRunPageHeaderActions(onImprove ? { onImprove } : null);
      return <div>run body</div>;
    }

    const pageProps = {
      run: makeRun({ _id: "this-run" }),
      hostNamesById,
      otherRuns: [makeRun({ _id: "other-run" })],
      defaultCompareRunId: "other-run",
      onCompareWithRun: vi.fn(),
    };
    const { rerender } = render(
      <EvaluateRunPage {...pageProps}>
        <HeaderActionChild />
      </EvaluateRunPage>,
    );

    expect(screen.getByRole("button", { name: "Compare runs" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();

    rerender(
      <EvaluateRunPage {...pageProps}>
        <HeaderActionChild onImprove={vi.fn()} />
      </EvaluateRunPage>,
    );

    const overflow = await screen.findByRole("button", { name: "Run actions" });
    expect(overflow).toBeVisible();
    await userEvent.setup().click(overflow);
    expect(
      screen.getByRole("menuitem", { name: "Prompt to improve" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Compare runs" })).toBeNull();
  });
});

describe("pairingDecision", () => {
  it("maps the run's stored verdict, and withholds Hold/Ship while in flight", () => {
    expect(pairingDecision(makeRun({ _id: "a", result: "passed" }))).toEqual({
      word: "Ship",
      tone: "ship",
    });
    expect(pairingDecision(makeRun({ _id: "b", result: "failed" }))).toEqual({
      word: "Hold",
      tone: "hold",
    });
    expect(
      pairingDecision(
        makeRun({ _id: "c", status: "timed_out", result: "pending" }),
      ),
    ).toEqual({ word: "Hold", tone: "hold" });
    expect(
      pairingDecision(
        makeRun({ _id: "d", status: "running", result: "pending" }),
      ),
    ).toEqual({ word: "Running", tone: "pending" });
    expect(
      pairingDecision(
        makeRun({ _id: "e", status: "grading", result: "pending" }),
      ),
    ).toEqual({ word: "Grading", tone: "pending" });
    expect(
      pairingDecision(
        makeRun({ _id: "f", status: "completed", result: "inconclusive" }),
      ),
    ).toEqual({ word: "Inconclusive", tone: "pending" });
  });
});

it("navigates directly to the comparison page when Compare runs is clicked", async () => {
  const onOpenComparison = vi.fn();
  render(
    <EvaluateRunPage
      run={makeRun({ _id: "current" })}
      otherRuns={[makeRun({ _id: "other" })]}
      hostNamesById={new Map()}
      defaultCompareRunId="other"
      onCompareWithRun={vi.fn()}
      onOpenComparison={onOpenComparison}
    >
      <p>Run details</p>
    </EvaluateRunPage>,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Compare runs" }));
  expect(onOpenComparison).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("evaluate-run-compare")).toBeNull();
});

describe("run heading and scope", () => {
  const iteration = (
    _id: string,
    suiteRunId: string,
    testCaseId: string,
  ): EvalIteration =>
    ({
      _id,
      suiteRunId,
      testCaseId,
      result: "passed",
      status: "completed",
    }) as unknown as EvalIteration;

  it("names the suite in the heading when the suite is in scope", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "current" })}
        suiteName="Excalidraw"
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <p>body</p>
      </EvaluateRunPage>,
    );

    expect(
      screen.getByRole("heading", { name: "Run #1 of Excalidraw" }),
    ).toBeVisible();
  });

  it("counts cases, iterations, and pairings from this page's runs only", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "current" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        iterations={[
          iteration("i1", "current", "case-a"),
          iteration("i2", "current", "case-a"),
          iteration("i3", "current", "case-b"),
          // Another run of the same suite. Its rows describe a different
          // population and must not inflate this page's counts.
          iteration("i4", "someone-else", "case-c"),
        ]}
      >
        <p>body</p>
      </EvaluateRunPage>,
    );

    expect(screen.getByTestId("evaluate-run-scope")).toHaveTextContent(
      "2 cases · 3 iterations · 1 client-model combo",
    );
  });

  it("says nothing about scope before any iteration has arrived", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "current" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        iterations={[]}
      >
        <p>body</p>
      </EvaluateRunPage>,
    );

    expect(screen.queryByTestId("evaluate-run-scope")).toBeNull();
  });
});

describe("EvaluateRunPage cancel", () => {
  const running = (id: string, overrides: Partial<EvalSuiteRun> = {}) =>
    makeRun({
      _id: id,
      status: "running",
      result: "pending",
      completedAt: undefined,
      runGroupId: "launch-1",
      ...overrides,
    });

  it("cancels every still-running pairing of the launch, not just this run", async () => {
    const user = userEvent.setup();
    const onCancelRun = vi.fn();
    render(
      <EvaluateRunPage
        run={running("run-a")}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        relatedRuns={[
          running("run-a"),
          running("run-b"),
          // Same launch, already finished: cancelling it would throw.
          makeRun({
            _id: "run-c",
            runGroupId: "launch-1",
            status: "completed",
          }),
        ]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        onCancelRun={onCancelRun}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    // Cancel takes the primary slot, so "Run again" is not offered beside a
    // run that is still going.
    expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(onCancelRun).toHaveBeenCalledWith(["run-a", "run-b"]);
  });

  it("gives the primary slot back to Run again once the run settles", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "run-a" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        onCancelRun={vi.fn()}
        launchReview={{ onStart: vi.fn() } as never}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.queryByTestId("evaluate-run-page-cancel")).toBeNull();
  });

  it("offers no cancel once the run has finished", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "run-a" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        onCancelRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.queryByTestId("evaluate-run-page-cancel")).toBeNull();
  });

  it("cancels a grading run — the judge is still billing", () => {
    render(
      <EvaluateRunPage
        run={running("run-a", { status: "grading" })}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        onCancelRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByTestId("evaluate-run-page-cancel")).toBeTruthy();
  });

  it("disables the button while the cancel is in flight", () => {
    render(
      <EvaluateRunPage
        run={running("run-a")}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
        onCancelRun={vi.fn()}
        cancellingRunId="run-a"
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
  });

  it("stays out of the way when the page has no cancel handler", () => {
    render(
      <EvaluateRunPage
        run={running("run-a")}
        hostNamesById={hostNamesById}
        otherRuns={[]}
        defaultCompareRunId={null}
        onCompareWithRun={vi.fn()}
      >
        <div>run body</div>
      </EvaluateRunPage>,
    );

    expect(screen.queryByTestId("evaluate-run-page-cancel")).toBeNull();
  });
});
