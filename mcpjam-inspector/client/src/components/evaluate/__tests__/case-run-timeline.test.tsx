import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";
import { CaseRunTimeline } from "../case-workspace/case-run-timeline";
const iteration = (
  id: string,
  model: string,
  result: string,
  elapsed: number,
) =>
  ({
    _id: id,
    createdAt: 1000,
    startedAt: 1000,
    updatedAt: 1000 + elapsed,
    result,
    status: result === "pending" ? "running" : "completed",
    testCaseSnapshot: { model },
    actualToolCalls: [],
  }) as unknown as EvalIteration;
describe("CaseRunTimeline", () => {
  it("switches client and model targets and updates their averages", async () => {
    const user = userEvent.setup();
    const trials = [
      {
        ...iteration("a", "snapshot-model", "passed", 1000),
        suiteRunId: "cursor",
      },
      {
        ...iteration("b", "snapshot-model", "failed", 3000),
        suiteRunId: "chatgpt",
      },
    ];
    render(
      <CaseRunTimeline
        caseTitle="Case"
        iterations={trials}
        selectedIterationId={null}
        onSelect={vi.fn()}
        hostNamesById={
          new Map([
            ["cursor", "Cursor"],
            ["chatgpt", "ChatGPT"],
          ])
        }
        suiteRuns={
          [
            {
              _id: "cursor",
              namedHostId: "cursor",
              effectiveModelId: "actual-a",
            },
            {
              _id: "chatgpt",
              namedHostId: "chatgpt",
              effectiveModelId: "actual-b",
            },
          ] as EvalSuiteRun[]
        }
      >
        Evidence
      </CaseRunTimeline>,
    );
    expect(screen.getAllByTestId("case-run-row")).toHaveLength(1);
    expect(screen.getByText("1/1")).toBeVisible();
    expect(screen.getByTestId("case-run-averages")).toHaveClass(
      "bg-background",
      "text-foreground",
    );
    expect(
      screen.getByTestId("case-run-row").closest(".overflow-x-auto"),
    ).toHaveClass("bg-background", "text-foreground");
    expect(screen.getByText("Iteration").parentElement).toHaveClass("bg-muted");
    await user.click(
      screen.getByRole("button", { name: "ChatGPT · actual-b", exact: true }),
    );
    expect(screen.getAllByTestId("case-run-row")).toHaveLength(1);
    expect(screen.getByText("0/1")).toBeVisible();
  });
  it("shows only the latest launch when older runs are loaded", () => {
    render(
      <CaseRunTimeline
        caseTitle="Case"
        iterations={[
          { ...iteration("old", "model", "passed", 1000), suiteRunId: "old" },
          { ...iteration("new", "model", "failed", 3000), suiteRunId: "new" },
        ]}
        suiteRuns={
          [
            {
              _id: "old",
              runNumber: 1,
              runGroupId: "old-launch",
              effectiveModelId: "model",
            },
            {
              _id: "new",
              runNumber: 2,
              runGroupId: "new-launch",
              effectiveModelId: "model",
            },
          ] as EvalSuiteRun[]
        }
        selectedIterationId={null}
        onSelect={vi.fn()}
      >
        Evidence
      </CaseRunTimeline>,
    );
    expect(screen.getAllByTestId("case-run-row")).toHaveLength(1);
    expect(screen.getByText("0/1")).toBeVisible();
  });
  it("shows the recorded client and model pair", () => {
    const trial = {
      ...iteration("trial-id", "old-model", "passed", 1000),
      suiteRunId: "run-123456789",
    };
    render(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        suiteName="Diagram suite"
        hostNamesById={new Map([["cursor", "Cursor"]])}
        iterations={[trial]}
        selectedIterationId={null}
        onSelect={vi.fn()}
        suiteRuns={[
          {
            _id: "run-123456789",
            effectiveModelId: "anthropic/claude-test",
            namedHostId: "cursor",
            runNumber: 7,
          } as EvalSuiteRun,
        ]}
      >
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    expect(
      screen.getByRole("button", { name: "Cursor · claude-test" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("case-run-row")).toHaveTextContent("Cursor");
    expect(screen.getByTestId("case-run-row")).toHaveTextContent("claude-test");
  });
  it("switches averages and selects iterations", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const a = iteration("a", "model-a", "passed", 1000),
      b = iteration("b", "model-b", "failed", 3000);
    render(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[a, b]}
        selectedIterationId="a"
        onSelect={onSelect}
      >
        <p>Run evidence</p>
      </CaseRunTimeline>,
    );
    expect(screen.getByText("1/1")).toBeInTheDocument();
    expect(screen.getAllByText("1.0s")).toHaveLength(3);
    await user.click(screen.getByTestId("case-run-row"));
    expect(onSelect).toHaveBeenCalledWith(a);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      screen.getByRole("button", {
        name: "Suite default · model-b",
        exact: true,
      }),
    );
    expect(screen.getByText("0/1")).toBeInTheDocument();
    await user.click(screen.getByTestId("case-run-row"));
    expect(onSelect).toHaveBeenCalledWith(b);
    expect(
      screen.getByRole("dialog", { name: "#1 Create a flowchart" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Run evidence")).toBeInTheDocument();
  });
  it("keeps run numbering chronological when filtering and handles a new live run", async () => {
    const user = userEvent.setup();
    const older = {
      ...iteration("older", "model-a", "passed", 1000),
      createdAt: 1000,
    };
    const newer = {
      ...iteration("newer", "model-b", "passed", 1000),
      createdAt: 2000,
    };
    const { rerender } = render(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[newer, older]}
        selectedIterationId="newer"
        onSelect={vi.fn()}
        live
      >
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    expect(
      screen.getByRole("heading", { name: "#2 Create a flowchart" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(
      screen.getByRole("button", {
        name: "Suite default · model-b",
        exact: true,
      }),
    );
    await user.click(screen.getByTestId("case-run-row"));
    expect(
      screen.getByRole("heading", { name: "#2 Create a flowchart" }),
    ).toBeInTheDocument();
    rerender(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[newer, older]}
        selectedIterationId={null}
        onSelect={vi.fn()}
        live
      >
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    expect(
      screen.getByRole("heading", { name: "#3 Create a flowchart" }),
    ).toBeInTheDocument();
  });

  it("uses the persisted run number even when only part of history is loaded", () => {
    const trial = {
      ...iteration("trial", "model-a", "passed", 1000),
      suiteRunId: "suite-run",
      iterationNumber: 2,
    };
    render(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[trial]}
        suiteRuns={[{ _id: "suite-run", runNumber: 42 } as EvalSuiteRun]}
        selectedIterationId="trial"
        onSelect={vi.fn()}
        live
      >
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    expect(
      screen.getByRole("heading", { name: "#42 Create a flowchart" }),
    ).toBeInTheDocument();
  });

  it("shows a yellow Running badge in the header and updates it on completion", () => {
    const props = {
      caseTitle: "Create a flowchart",
      iterations: [],
      selectedIterationId: null,
      onSelect: vi.fn(),
      live: true,
    };
    const { rerender } = render(
      <CaseRunTimeline {...props} liveVerdict="Running">
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    const badge = screen.getByTestId("case-run-status");
    expect(badge.previousElementSibling?.tagName).toBe("H2");
    expect(badge).toHaveTextContent("Running");
    expect(badge).toHaveClass("bg-warning/30");
    expect(badge.parentElement).toContainElement(
      screen.getByRole("heading", { name: "#1 Create a flowchart" }),
    );
    rerender(
      <CaseRunTimeline {...props} liveVerdict="Passed">
        <p>Evidence</p>
      </CaseRunTimeline>,
    );
    expect(screen.getByTestId("case-run-status")).toHaveTextContent("Passed");
    expect(screen.getByTestId("case-run-status")).not.toHaveClass(
      "bg-warning/30",
    );
  });

  it("collapses evidence and handles empty history", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[iteration("a", "model-a", "pending", 0)]}
        selectedIterationId="a"
        onSelect={vi.fn()}
      >
        <p>Run evidence</p>
      </CaseRunTimeline>,
    );
    await user.click(screen.getByTestId("case-run-row"));
    expect(
      screen.getByRole("dialog", { name: "#1 Create a flowchart" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    rerender(
      <CaseRunTimeline
        caseTitle="Create a flowchart"
        iterations={[]}
        selectedIterationId={null}
        onSelect={vi.fn()}
      >
        <p>Preview</p>
      </CaseRunTimeline>,
    );
    expect(
      screen.getByText("Run this case to see its results here."),
    ).toBeInTheDocument();
  });
});

it("names a single-case run from its frozen case title", async () => {
  const trial = { ...iteration("t", "m", "passed", 100), suiteRunId: "run" };
  render(
    <CaseRunTimeline
      caseTitle="Edited title"
      suiteName="Suite"
      iterations={[trial]}
      suiteRuns={[
        {
          _id: "run",
          runNumber: 12,
          configSnapshot: { tests: [{ title: "Original case" }] },
        } as EvalSuiteRun,
      ]}
      selectedIterationId="t"
      onSelect={vi.fn()}
      live
    >
      <p>Evidence</p>
    </CaseRunTimeline>,
  );
  expect(
    screen.getByRole("heading", { name: "#12 Original case" }),
  ).toBeVisible();
});

it("opens a deep-linked iteration in the drawer and allows it to stay closed", async () => {
  const props = {
    caseTitle: "Case",
    iterations: [iteration("a", "gpt", "passed", 1000)],
    selectedIterationId: "a",
    openIterationId: "a",
    onSelect: vi.fn(),
  };
  const { rerender } = render(
    <CaseRunTimeline {...props}>Captured evidence</CaseRunTimeline>,
  );
  expect(screen.getByRole("dialog")).toHaveTextContent("Captured evidence");
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Close", exact: true }));
  rerender(<CaseRunTimeline {...props}>Captured evidence</CaseRunTimeline>);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows an opening live run as a row and replaces it with its recorded iteration", async () => {
  const onSelectLive = vi.fn();
  const props = {
    caseTitle: "Search",
    selectedIterationId: null,
    onSelect: vi.fn(),
    onSelectLive,
  };
  const { rerender } = render(
    <CaseRunTimeline
      {...props}
      iterations={[]}
      pendingRun={{ model: "nova", client: "SDK" }}
    >
      Evidence
    </CaseRunTimeline>,
  );
  expect(screen.queryByText("View live run")).toBeNull();
  expect(
    screen.queryByText("Run this case to see its results here."),
  ).toBeNull();
  const row = screen.getByTestId("case-run-row");
  expect(row).toHaveTextContent("Running");
  expect(row).toHaveTextContent("nova");
  expect(row).toHaveTextContent("SDK");
  await userEvent.setup().click(row);
  expect(onSelectLive).toHaveBeenCalledOnce();
  await userEvent.setup().click(screen.getByRole("button", { name: "Close" }));
  rerender(
    <CaseRunTimeline
      {...props}
      iterations={[iteration("live", "nova", "pending", 0)]}
    >
      Evidence
    </CaseRunTimeline>,
  );
  expect(screen.getAllByTestId("case-run-row")).toHaveLength(1);
  expect(screen.getByTestId("case-run-row")).toHaveTextContent("Running");
  rerender(
    <CaseRunTimeline
      {...props}
      iterations={[iteration("live", "nova", "passed", 1000)]}
      liveVerdict="Passed"
    >
      Evidence
    </CaseRunTimeline>,
  );
  expect(screen.getAllByTestId("case-run-row")).toHaveLength(1);
  expect(screen.getByTestId("case-run-row")).toHaveTextContent("Passed");
  expect(screen.queryByText("View live run")).toBeNull();
});
