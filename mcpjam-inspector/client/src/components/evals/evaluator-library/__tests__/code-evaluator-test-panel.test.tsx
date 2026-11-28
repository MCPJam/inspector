import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, within } from "@/test";
import {
  CodeEvaluatorTestError,
  type CodeEvaluatorTestResult,
} from "@/lib/apis/code-evaluator-test-api";
import { CodeEvaluatorEditor } from "../code-evaluator-editor";
import { CodeEvaluatorTestPanel } from "../code-evaluator-test-panel";
import type { CodeEvaluatorDraft } from "../code-evaluator-model";

const convex = vi.hoisted(() => ({
  iterations: [
    {
      iterationId: "it-1",
      runNumber: 12,
      title: "Create an invoice for ACME",
      result: "passed",
      createdAt: 0,
    },
  ] as unknown[] | undefined,
}));
vi.mock("convex/react", () => ({ useQuery: () => convex.iterations }));

const api = vi.hoisted(() => ({ test: vi.fn() }));
vi.mock("@/lib/apis/code-evaluator-test-api", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/apis/code-evaluator-test-api")
  >()),
  testCodeEvaluator: api.test,
}));

const TARGET = {
  projectId: "project-1",
  suiteId: "suite-1",
  network: "none" as const,
};
const DRAFT: CodeEvaluatorDraft = {
  name: "Invoice totals add up",
  fileName: "check_totals.py",
  script: "print('checking')",
  role: "advisory",
  threshold: 1,
};

const PASSED: CodeEvaluatorTestResult = {
  runId: "run-12",
  iterationId: "it-1",
  input: "stored",
  network: "none",
  result: {
    status: "scored",
    score: 1,
    threshold: 1,
    passed: true,
    reason: "Every invoice total matches its items",
  },
  logs: { output: "Checked 2 invoices\n", exitCode: 0, durationMs: 400 },
};

beforeEach(() => {
  api.test.mockReset();
  convex.iterations = [
    {
      iterationId: "it-1",
      runNumber: 12,
      title: "Create an invoice for ACME",
      result: "passed",
      createdAt: 0,
    },
  ];
});

function renderPanel(
  props: Partial<Parameters<typeof CodeEvaluatorTestPanel>[0]> = {},
) {
  const view = renderWithProviders(
    <CodeEvaluatorTestPanel target={TARGET} draft={DRAFT} {...props} />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Test on a past iteration" }),
  );
  return view;
}

async function runTest(result: CodeEvaluatorTestResult = PASSED) {
  api.test.mockResolvedValueOnce(result);
  fireEvent.click(screen.getByRole("button", { name: "Run test" }));
  await screen.findByTestId("code-evaluator-test-result");
}

describe("CodeEvaluatorTestPanel", () => {
  it("starts collapsed under the judge panel's heading", () => {
    renderWithProviders(
      <CodeEvaluatorTestPanel target={TARGET} draft={DRAFT} />,
    );
    expect(
      screen.getByRole("heading", { name: "Test on a past iteration" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
  });

  it("runs the draft on the newest iteration with the suite's network", async () => {
    renderPanel({
      evaluatorId: "check_totals",
      target: { ...TARGET, network: "web" },
    });
    expect(
      screen.getByRole("combobox", { name: "Past iteration" }),
    ).toHaveTextContent(
      "Recent iteration 1 · Run #12 · Create an invoice for ACME",
    );
    expect(screen.getByText("Saves nothing.")).toBeInTheDocument();
    await runTest();
    expect(api.test).toHaveBeenCalledWith({
      projectId: "project-1",
      suiteId: "suite-1",
      iterationId: "it-1",
      evaluator: {
        fileName: "check_totals.py",
        script: "print('checking')",
        threshold: 1,
        id: "check_totals",
      },
      network: "web",
    });
  });

  it("shows a pass with its score, reason and collapsed logs", async () => {
    renderPanel();
    await runTest();
    const card = screen.getByTestId("code-evaluator-test-result");
    expect(within(card).getByText("Passed")).toBeInTheDocument();
    expect(card).toHaveTextContent("1.00 / 1.00");
    expect(card).toHaveTextContent("Every invoice total matches its items");
    const logs = within(card).getByText("Logs").closest("details");
    expect(logs).not.toHaveAttribute("open");
    expect(logs).toHaveTextContent("Checked 2 invoices");
    // The last verdict stays on the tray's handle.
    expect(screen.getAllByText("Passed")).toHaveLength(2);
  });

  it("shows a fail with the score under the passing score", async () => {
    renderPanel();
    await runTest({
      ...PASSED,
      result: { status: "scored", score: 0.5, threshold: 0.8, passed: false },
    });
    const card = screen.getByTestId("code-evaluator-test-result");
    expect(within(card).getByText("Failed")).toBeInTheDocument();
    expect(card).toHaveTextContent("0.50 / 0.80");
  });

  it("shows an evaluator error with its logs open, not counted as a failure", async () => {
    renderPanel();
    await runTest({
      ...PASSED,
      result: { status: "error", error: "Stopped at its time limit." },
      logs: { output: "Requesting rates\n", durationMs: 60_000 },
    });
    const card = screen.getByTestId("code-evaluator-test-result");
    expect(within(card).getByText("Error")).toBeInTheDocument();
    expect(card).toHaveTextContent("Stopped at its time limit.");
    expect(card).toHaveTextContent("Not counted as a failure.");
    expect(within(card).getByText("Logs").closest("details")).toHaveAttribute(
      "open",
    );
  });

  it("says when the evaluator saw the transcript only", async () => {
    renderPanel();
    await runTest({ ...PASSED, input: "transcript" });
    expect(
      screen.getByText(
        "This iteration has no stored files, so the evaluator saw the transcript only.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the last result after an edit, marked out of date", async () => {
    const { rerender } = renderPanel();
    await runTest();
    expect(
      screen.queryByText("From an earlier draft. Run the test again."),
    ).toBeNull();
    rerender(
      <CodeEvaluatorTestPanel
        target={TARGET}
        draft={{ ...DRAFT, script: "print('fixed')" }}
      />,
    );
    expect(
      screen.getByText("From an earlier draft. Run the test again."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("code-evaluator-test-result")).toHaveTextContent(
      "Every invoice total matches its items",
    );
  });

  it("shows a spinner while the test runs", async () => {
    renderPanel();
    let finish: (result: CodeEvaluatorTestResult) => void = () => {};
    api.test.mockReturnValueOnce(
      new Promise<CodeEvaluatorTestResult>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(screen.getByRole("button", { name: "Testing…" })).toBeDisabled();
    expect(
      screen.getByText("Running the test. It can take up to two minutes."),
    ).toBeInTheDocument();
    finish(PASSED);
    await screen.findByTestId("code-evaluator-test-result");
  });

  it.each([
    "This iteration's run hasn't finished. Test on an iteration from a finished run.",
    "You just tested an evaluator on this iteration. Wait a few seconds, then try again.",
    "Code evaluators is not currently available for your organization.",
    "Eval iteration not found",
    "Every test box is busy. Try again in a minute.",
  ])("shows a refused test's message as is: %s", async (message) => {
    renderPanel();
    api.test.mockRejectedValueOnce(new CodeEvaluatorTestError(message));
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("says to run the test again after an unexpected failure", async () => {
    renderPanel();
    api.test.mockRejectedValueOnce(new Error("boom"));
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't test the evaluator on this iteration. Run the test again.",
    );
  });

  it("doesn't run a draft that can't run, and says why", () => {
    renderPanel({ draft: { ...DRAFT, fileName: "check.rb" } });
    expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled();
    expect(
      screen.getByText("End the file name in .py, .ts, .js or .sh."),
    ).toBeInTheDocument();
  });

  it("asks for a run of the suite when there is no past iteration", () => {
    convex.iterations = [];
    renderPanel();
    expect(
      screen.getByText(
        "Run this suite once to test an evaluator on a past iteration.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run test" })).toBeNull();
  });

  it("waits for the iterations before it can run", () => {
    convex.iterations = undefined;
    renderPanel();
    expect(screen.getByRole("button", { name: "Run test" })).toBeDisabled();
  });

  it("docks in the editor between the form and the footer", () => {
    renderWithProviders(
      <CodeEvaluatorEditor
        inDialog
        others={[]}
        scripts={undefined}
        test={TARGET}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    const handle = screen.getByRole("button", {
      name: "Test on a past iteration",
    });
    const score = screen.getByRole("spinbutton", { name: "Passing score" });
    const add = screen.getByRole("button", { name: "Add evaluator" });
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(score, handle)).toBe(true);
    expect(follows(handle, add)).toBe(true);
  });

  it("isn't in the editor for a suite outside a project", () => {
    renderWithProviders(
      <CodeEvaluatorEditor
        inDialog
        others={[]}
        scripts={undefined}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Test on a past iteration" }),
    ).toBeNull();
  });
});
