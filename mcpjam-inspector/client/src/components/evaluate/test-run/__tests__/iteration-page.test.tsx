import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import type { EvalCrumb, EvalBack } from "../../nav/eval-nav-crumbs";
import type { TestRunData } from "../use-test-run-data";
import { IterationPage, iterationVerdict } from "../iteration-page";
import { formatRunId } from "../../../evals/helpers";
import {
  NOW,
  CASE_ID,
  ITERATIONS,
  MATRIX,
  RUN_A,
  RUN_B,
  SUITE,
  TEST_CASE,
  fixtureIteration,
} from "./test-run-fixtures";

const mocks = vi.hoisted(() => ({
  iteration: undefined as EvalIteration | null | undefined,
  ownRun: {
    run: null as EvalSuiteRun | null,
    isLoading: false,
    isUnavailable: false,
  },
  data: null as TestRunData | null,
  evidence: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQueries: () => ({ iteration: mocks.iteration }),
}));
vi.mock("../../../evals/use-selected-run", () => ({
  useSelectedRun: () => mocks.ownRun,
}));
vi.mock("../use-test-run-data", () => ({ useTestRunData: () => mocks.data }));
vi.mock("../use-test-run-decisions", () => ({
  useTestRunDecisions: () => ({ readers: null, byRun: new Map(), rows: [] }),
}));
vi.mock("../iteration-evidence", () => ({
  IterationEvidence: (props: { run: EvalSuiteRun }) => {
    mocks.evidence(props);
    return <div data-testid="evidence" />;
  },
}));
vi.mock("@/components/evaluate/evals-header", () => ({
  EvalCrumbBar: ({
    crumbs,
    back,
  }: {
    crumbs: readonly EvalCrumb[];
    back?: EvalBack | null;
  }) => (
    <nav aria-label="Crumbs">
      {crumbs.map((crumb) => crumb.label).join(" / ")}
      {back ? ` | ${back.label}` : ""}
    </nav>
  ),
}));

const route = {
  type: "iteration" as const,
  suiteId: "suite-excalidraw",
  runId: "run-a",
  testCaseId: CASE_ID,
  iterationId: "a1",
};

beforeEach(() => {
  mocks.iteration = ITERATIONS[0];
  mocks.ownRun = { run: null, isLoading: false, isUnavailable: false };
  mocks.data = {
    status: "ready",
    suite: SUITE,
    run: RUN_A,
    launchRuns: [RUN_A, RUN_B],
    iterations: ITERATIONS,
    source: "case",
    truncated: false,
    testCase: TEST_CASE,
    title: TEST_CASE.title,
    matrix: MATRIX,
  };
  mocks.evidence.mockReset();
  mocks.track.mockReset();
});

describe("IterationPage", () => {
  it("heads the card like the case run sheet, under the full trail", () => {
    render(<IterationPage route={route} projectId="p1" />);
    expect(
      screen.getByRole("navigation", { name: "Crumbs" }),
    ).toHaveTextContent(
      "Evaluate / Excalidraw quickstart / Run #4 / Sketch a two-node flow / Iteration #1 | Back to test run",
    );
    expect(
      screen.getByRole("heading", { name: "#4 Sketch a two-node flow" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed")).toHaveClass("bg-destructive/15");
    expect(
      screen.getByText(
        new RegExp(`^Run ${formatRunId("run-a")} · openai/gpt-5-mini · `),
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("evidence")).toBeInTheDocument();
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({
        page: "iteration",
        ui: "nav",
        project_id: "p1",
      }),
    );
  });

  it("titles the card with the suite when the run held several cases", () => {
    mocks.data = {
      ...mocks.data!,
      launchRuns: [
        {
          ...RUN_A,
          configSnapshot: {
            ...RUN_A.configSnapshot,
            tests: [
              ...RUN_A.configSnapshot.tests,
              ...RUN_A.configSnapshot.tests,
            ],
          },
        },
      ],
    };
    render(<IterationPage route={route} projectId="p1" />);
    expect(
      screen.getByRole("heading", { name: "#4 Excalidraw quickstart" }),
    ).toBeInTheDocument();
  });

  it("uses the iteration's own run, a launch sibling", () => {
    mocks.iteration = ITERATIONS[4];
    render(
      <IterationPage route={{ ...route, iterationId: "b1" }} projectId="p1" />,
    );
    expect(mocks.evidence).toHaveBeenCalledWith(
      expect.objectContaining({ run: RUN_B }),
    );
    expect(
      screen.getByRole("heading", { name: "#5 Sketch a two-node flow" }),
    ).toBeInTheDocument();
  });

  it("numbers an iteration with none by its place among its target's iterations", () => {
    mocks.iteration = { ...ITERATIONS[1], iterationNumber: 0 };
    mocks.data = {
      ...mocks.data!,
      iterations: [ITERATIONS[0], mocks.iteration],
    };
    render(
      <IterationPage route={{ ...route, iterationId: "a2" }} projectId="p1" />,
    );
    expect(
      screen.getByRole("navigation", { name: "Crumbs" }),
    ).toHaveTextContent("Iteration #2");
  });

  it.each([
    ["missing", () => (mocks.iteration = null)],
    [
      "of another case",
      () =>
        (mocks.iteration = fixtureIteration("x", "run-a", {
          testCaseId: "other",
        })),
    ],
    [
      "of another suite",
      () => {
        mocks.iteration = fixtureIteration("x", "run-elsewhere");
        mocks.ownRun = { run: null, isLoading: false, isUnavailable: true };
      },
    ],
  ])("says not found when the iteration is %s", (_, arrange) => {
    arrange();
    render(<IterationPage route={route} projectId="p1" />);
    expect(
      screen.getByText(
        "This iteration is not part of this test run. Check the link, or go back to the test run.",
      ),
    ).toBeInTheDocument();
  });
});

describe("the Iteration description's age", () => {
  afterEach(() => vi.useRealTimers());
  it("counts whole days past a week, like the case run sheet", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW + 60_000);
    render(<IterationPage route={route} projectId="p1" />);
    expect(
      screen.getByText(
        `Run ${formatRunId("run-a")} · openai/gpt-5-mini · 13d ago`,
      ),
    ).toBeInTheDocument();
  });
});

describe("iterationVerdict", () => {
  it.each([
    [{ result: "passed" }, "Passed"],
    [{ result: "failed" }, "Failed"],
    [{ result: "timed_out", status: "timed_out" }, "Timeout"],
    [{ result: "cancelled", status: "cancelled" }, "Cancelled"],
    [{ result: "pending", status: "pending" }, "Pending"],
    [{ result: "pending", status: "running" }, "Running"],
  ] as const)("%o reads %s", (overrides, word) => {
    expect(iterationVerdict(fixtureIteration("i", "r", overrides))).toBe(word);
  });
});
