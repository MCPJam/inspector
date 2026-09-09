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

    expect(screen.getByTestId("evaluate-run-page")).toHaveTextContent(
      "Run #1 Results",
    );
    expect(screen.getByText("run body")).toBeTruthy();
    expect(screen.queryByText("All runs")).toBeNull();
    expect(screen.queryByText("latest + trends per client")).toBeNull();
    const header = screen.getByTestId("evaluate-run-header");
    expect(
      within(header).getByRole("heading", { name: "Run #1 Results" }),
    ).toHaveClass("text-2xl", "font-bold", "tracking-tight");
    expect(
      within(header).getByRole("heading", { name: "Run #1 Results" }),
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
    const pill = screen.getByTestId("run-header-decision-pill");
    expect(pill).toHaveAttribute("data-decision", "hold");
    expect(within(header).queryByText(/\d+ of \d+/)).toBeNull();
    expect(pill).toHaveClass("h-8", "rounded-full");
    expect(pill).toHaveClass("border-warning/30", "bg-warning/10", "text-warning");
    expect(pill).not.toHaveClass("border-destructive/30", "text-destructive");
    expect(within(pill).getByTestId("run-header-pairing-decision")).toHaveTextContent(
      "HOLD",
    );
    const mark = within(pill).getByLabelText("Claude · Client default");
    expect(mark).toHaveClass("bg-background", "rounded-full");
    expect(mark.querySelector("img")).toHaveAttribute("alt", "");
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
      const pill = within(header).getByTestId("run-header-decision-pill");
      expect(pill).toHaveClass("h-8", "rounded-full");
      expect(within(pill).getByTestId("run-header-pairing-decision")).toHaveTextContent(
        label,
      );
      const mark = within(pill).getByLabelText("Claude · Client default");
      expect(mark).toBeVisible();
      expect(mark).toHaveClass("bg-background");
      expect(mark.querySelector("img")).toBeVisible();
      expect(within(header).queryByText("Failed")).toBeNull();
      expect(within(header).queryByText("Passed")).toBeNull();
      expect(within(header).queryByTestId("run-header-verdict")).toBeNull();
    },
  );

  it("uses a stable run title and removes individual client report switching", async () => {
    const user = userEvent.setup();
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
    expect(
      screen.getByRole("heading", { name: "Run #1 Results" }),
    ).toBeVisible();
    expect(screen.queryByText(/client\/model pairing/)).toBeNull();
    const pairings = screen.getByTestId("run-header-pairings");
    const pills = within(pairings).getAllByTestId("run-header-decision-pill");
    expect(pills).toHaveLength(2);
    expect(pills[0]).toHaveAttribute("data-decision", "hold");
    expect(pills[1]).toHaveAttribute("data-decision", "ship");
    expect(pills[0]).toHaveClass("h-8", "rounded-full");
    expect(pills[1]).toHaveClass("h-8", "rounded-full");
    expect(pills[0]).toHaveClass("border-warning/30", "bg-warning/10", "text-warning");
    expect(pills[0]).not.toHaveClass("text-destructive");
    expect(pills[1]).toHaveClass("border-success/30", "bg-success/10");
    expect(
      within(pills[0]).getByTestId("run-header-pairing-decision"),
    ).toHaveTextContent("HOLD");
    expect(
      within(pills[1]).getByTestId("run-header-pairing-decision"),
    ).toHaveTextContent("SHIP");
    expect(within(pills[0]).getByLabelText("Claude · sonnet")).toBeVisible();
    expect(within(pills[0]).getByLabelText("Claude · sonnet")).toHaveClass(
      "bg-background",
      "rounded-full",
    );
    expect(within(pills[1]).getByLabelText("Claude · opus")).toBeVisible();
    expect(within(pills[0]).queryByLabelText("Claude · opus")).toBeNull();
    expect(within(pills[1]).queryByLabelText("Claude · sonnet")).toBeNull();
    await user.hover(within(pills[0]).getByLabelText("Claude · sonnet"));
    expect(
      await screen.findByRole("tooltip", { hidden: true }),
    ).toHaveTextContent("Claude · sonnet");
    expect(screen.queryByRole("button", { name: /Client report/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Run details" })).toBeNull();
    expect(screen.queryByText("sonnet")).toBeNull();
    expect(screen.queryByText("opus")).toBeNull();
  });

  it("stacks every Hold client in one pill and omits an empty Ship pill", () => {
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
    const pills = screen.getAllByTestId("run-header-decision-pill");
    expect(pills).toHaveLength(1);
    expect(pills[0]).toHaveAttribute("data-decision", "hold");
    expect(within(pills[0]).getAllByLabelText(/ · /)).toHaveLength(2);
    expect(screen.queryByText("SHIP")).toBeNull();
    expect(screen.queryByText("Hold:")).toBeNull();
    expect(screen.queryByText("HOLD:")).toBeNull();
    expect(
      within(pills[0]).getByTestId("run-header-pairing-decision"),
    ).toHaveTextContent("HOLD");
  });

  it("recovers the pairing model from iterations when the run omitted it", () => {
    render(
      <EvaluateRunPage
        run={makeRun({ _id: "run-1" })}
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
      pairingDecision(makeRun({ _id: "c", status: "timed_out", result: "pending" })),
    ).toEqual({ word: "Hold", tone: "hold" });
    expect(
      pairingDecision(makeRun({ _id: "d", status: "running", result: "pending" })),
    ).toEqual({ word: "Running", tone: "pending" });
    expect(
      pairingDecision(makeRun({ _id: "e", status: "grading", result: "pending" })),
    ).toEqual({ word: "Grading", tone: "pending" });
    expect(
      pairingDecision(
        makeRun({ _id: "f", status: "completed", result: "inconclusive" }),
      ),
    ).toEqual({ word: "Inconclusive", tone: "pending" });
  });
});
