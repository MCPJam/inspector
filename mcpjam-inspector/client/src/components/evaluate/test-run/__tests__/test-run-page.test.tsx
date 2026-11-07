import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EvalCrumb, EvalBack } from "../../nav/eval-nav-crumbs";
import type { TestRunData } from "../use-test-run-data";
import { TestRunPage } from "../test-run-page";
import {
  CASE_ID,
  ITERATIONS,
  MATRIX,
  RUN_A,
  RUN_B,
  SUITE,
  TEST_CASE,
} from "./test-run-fixtures";

const mocks = vi.hoisted(() => ({
  data: null as TestRunData | null,
  navigate: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  useAppNavigate: () => mocks.navigate,
}));
vi.mock("../use-test-run-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../use-test-run-data")>()),
  useTestRunData: () => mocks.data,
}));
vi.mock("../use-test-run-decisions", () => ({
  useTestRunDecisions: () => ({ readers: null, byRun: new Map(), rows: [] }),
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
  type: "test-run" as const,
  suiteId: "suite-excalidraw",
  runId: "run-a",
  testCaseId: CASE_ID,
};
const ready: TestRunData = {
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
const base = "/evaluate/suite/suite-excalidraw/runs/run-a/cases/case-sketch";
const fromHere = {
  evalNav: { via: "link", from: { path: base, place: "test run" } },
};
const tracked = (event: string) =>
  mocks.track.mock.calls
    .filter(([name]) => name === event)
    .map(([, props]) => props);

beforeEach(() => {
  mocks.data = ready;
  mocks.navigate.mockReset();
  mocks.track.mockReset();
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
});

describe("TestRunPage", () => {
  it("draws 1B's crumbs and Back, and counts a nav page view", () => {
    render(<TestRunPage route={route} projectId="p1" />);
    expect(
      screen.getByRole("navigation", { name: "Crumbs" }),
    ).toHaveTextContent(
      "Evaluate / Excalidraw quickstart / Run #4 / Sketch a two-node flow | Back to Run #4",
    );
    expect(screen.getByTestId("nav-test-run")).toBeInTheDocument();
    expect(tracked("eval_nav_page_viewed")).toEqual([
      expect.objectContaining({
        page: "test_run",
        ui: "nav",
        project_id: "p1",
      }),
    ]);
  });

  it("edits the case from the page, counting it first", () => {
    render(<TestRunPage route={route} projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Test Case" }));
    expect(tracked("eval_edit_from_test_run")).toEqual([
      expect.objectContaining({ surface: "page", project_id: "p1" }),
    ]);
    expect(mocks.navigate).toHaveBeenCalledWith(`${base}/edit`, {
      replace: undefined,
      state: fromHere,
    });
  });

  it("opens an iteration as a link from this page", () => {
    render(<TestRunPage route={route} projectId="p1" />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open iteration 1 details" }),
    );
    expect(mocks.navigate).toHaveBeenCalledWith(`${base}/iter/a1`, {
      replace: undefined,
      state: fromHere,
    });
  });

  it("writes the picked model to ?target= in place, and reads it back", () => {
    const view = render(<TestRunPage route={route} projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /claude-haiku-4.5/ }));
    const [path, options] = mocks.navigate.mock.calls[0];
    expect(path).toContain(
      `target=${encodeURIComponent(MATRIX.targets[1].targetKey)}`,
    );
    expect(options).toMatchObject({ replace: true });

    view.rerender(
      <TestRunPage
        route={{ ...route, target: MATRIX.targets[1].targetKey }}
        projectId="p1"
      />,
    );
    expect(
      screen.getByRole("button", { name: /claude-haiku-4.5/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(tracked("eval_nav_page_viewed")).toHaveLength(1);
  });

  it("opens the preview by click, counted once, and a step opens the editor there", () => {
    window.history.pushState({}, "", `/p/proj00000000000001${base}`);
    render(<TestRunPage route={route} projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Execution preview" }));
    expect(tracked("eval_execution_preview_opened")).toEqual([
      expect.objectContaining({
        surface: "test_run",
        project_id: "proj00000000000001",
      }),
    ]);
    window.history.pushState({}, "", "/");
    fireEvent.click(screen.getByText("Expected outcome"));
    expect(tracked("eval_edit_from_test_run")).toEqual([
      expect.objectContaining({ surface: "preview_step" }),
    ]);
    expect(mocks.navigate).toHaveBeenCalledWith(`${base}/edit?step=outcome`, {
      state: fromHere,
    });
  });

  it("restores an open preview without counting it", () => {
    window.localStorage.setItem("mcpjam:eval-execution-preview-open", "1");
    render(<TestRunPage route={route} projectId="p1" />);
    expect(
      screen.getByRole("complementary", { name: "Execution preview" }),
    ).toBeInTheDocument();
    expect(tracked("eval_execution_preview_opened")).toEqual([]);
  });

  it("has no preview when the case could not be read", () => {
    mocks.data = { ...ready, testCase: null };
    render(<TestRunPage route={route} projectId="p1" />);
    expect(
      screen.queryByRole("button", { name: "Execution preview" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit Test Case" }),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "runNotFound",
      "This run is not in this suite's history. Check the link, or open the suite to see its runs.",
    ],
    [
      "caseNotInRun",
      "This test case did not run in Run #4. Go back to Run #4 to pick another test run.",
    ],
  ] as const)("says %s", (status, text) => {
    mocks.data = { ...ready, status };
    render(<TestRunPage route={route} projectId="p1" />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shows placeholders and pending crumbs while loading", () => {
    mocks.data = { ...ready, status: "loading", suite: null, run: null };
    render(<TestRunPage route={route} projectId="p1" />);
    expect(screen.getByTestId("nav-test-run-loading")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Crumbs" }),
    ).toHaveTextContent("Evaluate / Suite / Run / Test case | Back to run");
  });
});
