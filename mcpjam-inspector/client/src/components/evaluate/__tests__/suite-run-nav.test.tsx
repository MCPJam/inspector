import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EvaluateRunPage,
  useEvaluateRunPageHeaderActions,
} from "../evaluate-run-page";
import {
  SingleRunTestRuns,
  SuiteRunTestRuns,
} from "../suite-run/suite-run-test-runs";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

const flag = vi.hoisted(() => ({ value: true as boolean | undefined }));
const navigate = vi.hoisted(() => vi.fn());
const track = vi.hoisted(() => vi.fn());

vi.mock("../nav/use-evaluate-nav-enabled", () => ({
  useEvaluateNavEnabled: () => flag.value,
}));
vi.mock("../nav/use-evaluate-nav-navigate", async (original) => ({
  ...(await original<object>()),
  useEvaluateNavNavigate: () => navigate,
}));
vi.mock("../nav/evaluate-nav-events", async (original) => ({
  ...(await original<object>()),
  trackEvalNav: track,
}));

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 4,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    namedHostId: "host-1",
    ...overrides,
  };
}

function makeIteration(
  id: string,
  caseId: string,
  title: string,
  result: "passed" | "failed",
  model = "gpt-5-mini",
): EvalIteration {
  return {
    _id: id,
    createdBy: "u1",
    createdAt: 1,
    startedAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    status: "completed",
    result,
    suiteRunId: "run-4",
    testCaseId: caseId,
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title,
      query: "q",
      provider: "openai",
      model,
      expectedToolCalls: [],
    },
  };
}

const decision = {
  summary: null,
  diagnostics: [],
  chains: new Map(),
  chainsLoaded: true,
  decisionStatus: "disabled" as const,
};

const iterations = [
  makeIteration("i1", "case-a", "Draw a rectangle", "passed"),
  makeIteration("i2", "case-b", "Sketch a two-node flow", "failed"),
];

beforeEach(() => {
  flag.value = true;
  navigate.mockReset();
  track.mockReset();
});

describe("Suite run header with evaluate-nav-enabled", () => {
  function HeaderActionChild() {
    const lifted = useEvaluateRunPageHeaderActions({ onImprove: vi.fn() });
    return <div>{lifted ? "lifted" : "kept in body"}</div>;
  }

  function renderPage() {
    return render(
      <EvaluateRunPage
        run={makeRun({ _id: "run-4" })}
        suiteName="Excalidraw quickstart"
        hostNamesById={new Map()}
        otherRuns={[makeRun({ _id: "run-3", runNumber: 3 })]}
        defaultCompareRunId="run-3"
        onCompareWithRun={vi.fn()}
        launchReview={{
          suite: { _id: "suite-1" } as never,
          cases: [],
          hostNamesById: new Map(),
          onStart: vi.fn(),
          onEditSettings: vi.fn(),
          disabledReason: null,
        }}
      >
        <HeaderActionChild />
      </EvaluateRunPage>,
    );
  }

  it("names the suite run, pills the suite and has no ⋮ menu", async () => {
    renderPage();
    const header = screen.getByTestId("evaluate-run-header");
    expect(
      within(header).getByRole("heading", { name: "Suite Run #4" }),
    ).toBeTruthy();
    expect(screen.getByTestId("suite-run-suite-pill")).toHaveTextContent(
      "Excalidraw quickstart",
    );
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();
    // Prompt to improve stays with the verdict hero in the body.
    expect(screen.getByText("kept in body")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to suite" })).toBeTruthy();

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Suite settings/ }));
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "suite-settings",
        suiteId: "suite-1",
        tab: "settings",
      },
      "link",
    );
  });

  it("keeps today's header when the flag is off", () => {
    flag.value = false;
    renderPage();
    expect(
      screen.getByRole("heading", { name: "Run #4 of Excalidraw quickstart" }),
    ).toBeTruthy();
    expect(screen.getByText("lifted")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Suite settings/ })).toBeNull();
    expect(screen.queryByTestId("suite-run-back")).toBeNull();
  });
});

describe("Test runs list", () => {
  it("opens a test run from its row or its open button", async () => {
    const user = userEvent.setup();
    render(
      <SuiteRunTestRuns
        link={{ suiteId: "suite-1", runId: "run-4" }}
        iterations={iterations}
        decision={decision}
      />,
    );
    expect(screen.getByTestId("suite-run-test-runs")).toHaveTextContent(
      /^Test runs 2/,
    );

    await user.click(screen.getByText("Draw a rectangle"));
    expect(navigate).toHaveBeenLastCalledWith(
      {
        type: "test-run",
        suiteId: "suite-1",
        runId: "run-4",
        caseId: "case-a",
      },
      "link",
    );

    await user.click(
      screen.getByRole("button", {
        name: "Open test run: Sketch a two-node flow",
      }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      {
        type: "test-run",
        suiteId: "suite-1",
        runId: "run-4",
        caseId: "case-b",
      },
      "link",
    );
    expect(track).not.toHaveBeenCalled();
  });

  it("edits from a test run and records it", async () => {
    render(
      <SuiteRunTestRuns
        link={{ suiteId: "suite-1", runId: "run-4", target: "gpt-5-mini" }}
        iterations={iterations}
        decision={decision}
      />,
    );
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "Edit test case: Draw a rectangle",
      }),
    );
    expect(track).toHaveBeenCalledWith("eval_edit_from_test_run", {
      surface: "list",
    });
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "test-run-edit",
        suiteId: "suite-1",
        runId: "run-4",
        caseId: "case-a",
      },
      "link",
    );
  });

  it("shows a model filter only when the run used several models", () => {
    const run = { _id: "run-4", suiteId: "suite-1" };
    const { rerender } = render(
      <SingleRunTestRuns
        run={run}
        iterations={iterations}
        decision={decision}
      />,
    );
    expect(screen.queryByText("Model")).toBeNull();

    rerender(
      <SingleRunTestRuns
        run={run}
        iterations={[
          ...iterations,
          makeIteration("i3", "case-a", "Draw a rectangle", "passed", "haiku"),
        ]}
        decision={decision}
      />,
    );
    expect(screen.getByText("Model")).toBeTruthy();
  });
});
