/**
 * The run body in each state the decision read can actually be in.
 *
 * One `it` per honest state, because the failure this page is most likely to
 * ship is not a broken render — it is a plausible one. A skeleton that says
 * "Passed" while a request is in flight, or a green tick on a run whose
 * decision came back 500, looks entirely correct on screen and is a lie about
 * the thing the reader came to check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  evalRunDecisionSummaryStructuralSchema,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import { EvaluateRunContent } from "../evaluate-run-content";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

const detailState = vi.hoisted(() => ({
  current: {
    status: "ready" as "disabled" | "loading" | "ready" | "error",
    summary: null as EvalRunDecisionSummary | null,
    error: null,
    diagnostics: [] as EvalRunDecisionDiagnostic[],
    scannedIterations: 3,
    serverComplete: true,
    walkExhausted: true,
    canLoadMore: false,
    isLoadingMore: false,
    pageError: null,
    loadMore: () => {},
    retryFailedPage: () => {},
  },
}));

vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => detailState.current,
}));

/**
 * A summary fixture, PARSED rather than cast.
 *
 * The first draft of this helper used a `verdictSource` that is not in the
 * vocabulary, and the `as` hid it until a label lookup rendered the literal
 * word "undefined" into a caveat line. Structural rather than refined, because
 * these fixtures deliberately pair a verdict with a source the cross-field
 * rules would reject, in order to exercise the renderer's own states.
 */
function summary(
  overrides: Partial<EvalRunDecisionSummary> = {},
): EvalRunDecisionSummary {
  return evalRunDecisionSummaryStructuralSchema.parse({
    schemaVersion: 1,
    runId: "run_1",
    runStatus: "completed",
    verdict: "failed",
    verdictSource: "legacy",
    counts: { measurementUnit: "trial", total: 3, passed: 2, failed: 1 },
    diagnostics: { items: [], complete: true, scannedIterations: 3 },
    ...overrides,
  }) as EvalRunDecisionSummary;
}

const DIAGNOSTIC = {
  iterationId: "it_1",
  iterationNumber: 1,
  testCaseId: "case_1",
  title: "Draw and share a diagram",
  status: "completed",
  result: "failed",
  chain: {
    status: "verified",
    stages: [
      { stage: "connection", state: "passed" },
      { stage: "discovery", state: "passed" },
      { stage: "selection", state: "failed", reason: "missingToolCall" },
      { stage: "call", state: "notReached" },
      { stage: "response", state: "notReached" },
      { stage: "userValue", state: "notMeasured" },
    ],
    firstFailedStage: "selection",
    failureCategory: "selection",
    stageAnalyzerVersion: 8,
  },
  expected: { toolNames: ["export_to_excalidraw"] },
  observed: { toolNames: ["create_view"] },
  evidence: {
    runId: "run_1",
    iterationId: "it_1",
    stage: "selection",
    tracePath: "/trace",
  },
  nextAction: "review tool selection and the tool catalog",
} as EvalRunDecisionDiagnostic;

const RUN = {
  _id: "run_1",
  status: "completed",
  result: "failed",
} as unknown as EvalSuiteRun;

const ITERATIONS = [
  { _id: "it_1", status: "completed", result: "failed", tokensUsed: 900 },
  { _id: "it_2", status: "completed", result: "passed", tokensUsed: 900 },
] as unknown as EvalIteration[];

function renderContent(
  props: Partial<React.ComponentProps<typeof EvaluateRunContent>> = {},
) {
  return render(
    <EvaluateRunContent
      projectId="proj_1"
      run={RUN}
      iterations={ITERATIONS}
      decisionSummaryEnabled
      {...props}
    />,
  );
}

afterEach(() => {
  cleanup();
  detailState.current = {
    ...detailState.current,
    status: "ready",
    summary: null,
    diagnostics: [],
  };
});

describe("EvaluateRunContent", () => {
  it("leads with the verdict and the failing case in one sentence", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();

    expect(screen.getByTestId("run-verdict-word")).toHaveTextContent("Failed");
    expect(screen.getByTestId("run-verdict-sentence")).toHaveTextContent(
      "Draw and share a diagram broke at Selection: an expected tool call was never made.",
    );
    // The expected/observed pair is the thing the old page never showed.
    expect(screen.getByText("export_to_excalidraw")).toBeInTheDocument();
    expect(screen.getByText("create_view")).toBeInTheDocument();
  });

  it("folds the counting caveats instead of leading with them", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();

    const caveats = screen.getByTestId("run-verdict-caveats");
    // Present, and closed: the accounting is available to anyone who asks and
    // is not the first thing a reader has to get through.
    expect(caveats).not.toHaveAttribute("open");
    expect(caveats).toHaveTextContent("legacy percent-threshold run");
    expect(caveats).toHaveTextContent("Counts are iterations, not cases");
    expect(caveats).toHaveTextContent(
      "1 non-passing of 3 trials examined — this is the run's whole non-passing set.",
    );
    expect(caveats).toHaveTextContent("It is a location, not a claim");
  });

  it("says nothing about a verdict while the read is in flight", () => {
    detailState.current = {
      ...detailState.current,
      status: "loading",
      summary: null,
      diagnostics: [],
    };
    renderContent();

    expect(screen.getByTestId("run-verdict-word").textContent).not.toMatch(
      PASS_WORDS,
    );
    expect(screen.queryByTestId("run-verdict-caveats")).toBeNull();
  });

  it("says nothing about a verdict when the read failed", () => {
    detailState.current = {
      ...detailState.current,
      status: "error",
      summary: null,
      diagnostics: [],
    };
    renderContent();

    expect(screen.getByTestId("run-verdict-word").textContent).not.toMatch(
      PASS_WORDS,
    );
    expect(screen.getByTestId("run-verdict-sentence")).toHaveTextContent(
      "could not be read",
    );
  });

  it("keeps the existing body below while the rows are still to come", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({ fallbackBody: <div>existing run detail</div> });

    // The migration seam: adding a headline must not remove information from
    // the page in the same step.
    expect(screen.getByText("existing run detail")).toBeInTheDocument();
  });

  it("opens the failing iteration through the app's own routing", async () => {
    const onOpenIteration = vi.fn();
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({ onOpenIteration });

    screen.getByTestId("run-verdict-open-trace").click();
    expect(onOpenIteration).toHaveBeenCalledWith({
      testCaseId: "case_1",
      iterationId: "it_1",
    });
  });

  it("offers no trace button when no diagnostic names a case row", () => {
    // `tracePath` is an API path, not an app route, and the case editor is the
    // only screen that consumes an iteration id. Without a testCaseId there is
    // nowhere honest to send the reader.
    const { testCaseId, ...withoutCase } =
      DIAGNOSTIC as EvalRunDecisionDiagnostic & {
        testCaseId?: string;
      };
    void testCaseId;
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [withoutCase as EvalRunDecisionDiagnostic],
    };
    renderContent({ onOpenIteration: vi.fn() });

    expect(screen.queryByTestId("run-verdict-open-trace")).toBeNull();
  });
});
