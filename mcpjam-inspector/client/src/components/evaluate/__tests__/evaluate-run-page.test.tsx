import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EvaluateRunPage } from "../evaluate-run-page";
import type { EvalSuiteRun, EvalSuite } from "../../evals/types";

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
  it("uses a simple Paper header with secondary actions in a menu", async () => {
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
    ).not.toHaveClass("font-mono");
    expect(within(header).queryByText("Report for")).toBeNull();
    expect(
      within(header).queryByTestId("evaluate-run-launch-context"),
    ).toBeNull();
    expect(screen.queryByTestId("evaluate-run-compare-open")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Run actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Compare runs" }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    ["timed_out", "pending", "Timed out"],
    ["grading", "pending", "Grading"],
    ["completed", "inconclusive", "Inconclusive"],
  ] as const)(
    "reports %s without relabeling it pending",
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
      expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
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
    expect(screen.getByText("2 client/model pairings")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Client report/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Run actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Run details" }));
    expect(screen.getByText("sonnet")).toBeVisible();
    expect(screen.getByText("opus")).toBeVisible();
    expect(screen.queryByText("other")).toBeNull();
  });

  it("keeps launch metadata in run details instead of the header", async () => {
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
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Run details" }));
    expect(screen.getByRole("dialog", { name: "Run details" })).toBeVisible();
    expect(screen.getByTestId("evaluate-run-launch-context")).toHaveTextContent(
      "Server",
    );
    expect(screen.getByTestId("evaluate-run-servers")).toHaveTextContent(
      "Excalidraw (App)",
    );
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

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Run actions" }));
    const compare = screen.getByTestId("evaluate-run-compare-open");
    expect(compare).toHaveAttribute("aria-disabled", "true");
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
    await user.click(screen.getByRole("button", { name: "Run actions" }));
    await user.click(screen.getByRole("menuitem", { name: "New run" }));
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

    expect(screen.getByRole("button", { name: "Export report" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run actions" }));
    await user.click(screen.getByTestId("evaluate-run-compare-open"));
    expect(screen.getByTestId("evaluate-run-compare")).toBeTruthy();
    expect(screen.queryByText("run body")).toBeNull();

    await user.click(screen.getByTestId("evaluate-run-compare-confirm"));
    expect(onCompareWithRun).toHaveBeenCalledWith("prev-run");
  });
});
