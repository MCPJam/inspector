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
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  evalCaseAggregationKey,
  evalRunDecisionDiagnosticSchema,
  evalRunDecisionSummaryStructuralSchema,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
} from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import { EvaluateRunContent } from "../evaluate-run-content";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";
import type { UnifiedFindingsSectionProps } from "../unified-findings-section";

vi.mock("../unified-findings-section", () => ({
  // The block now occupies the hero's explanation slot, so the mock renders
  // its fallback: a run with no findings built still says what broke.
  UnifiedFindingsSection: ({
    suiteRunId,
    fallback,
  }: UnifiedFindingsSectionProps) => (
    <section data-testid="unified-findings-section" data-run-id={suiteRunId}>
      {fallback}
    </section>
  ),
}));

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

vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: () => ({ chains: [], status: "ready" }),
}));

vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => detailState.current,
}));

const stageAnalytics = vi.hoisted(() => ({
  current: {
    status: "absent" as string,
    document: null as unknown,
    error: null,
  },
}));
const flagEnabled = vi.hoisted(() => ({ current: false }));
const descriptionExperimentFlag = vi.hoisted(() => ({ current: false }));
// Retained as input to the improve prompt, not as a bottom-page section.
const serverQuality = vi.hoisted(() => ({
  current: { result: null as unknown },
}));
const descriptionExperiment = vi.hoisted(() => ({
  calls: [] as Array<{ enabled?: boolean }>,
  current: {
    status: "idle" as string,
    experiment: null as unknown,
    error: null,
    propose: () => Promise.resolve(),
    start: () => Promise.resolve(),
    refetch: () => {},
  },
}));
const compareState = vi.hoisted(() => ({
  current: {
    status: "disabled" as string,
    dto: null as unknown,
    errorKind: null as string | null,
  },
}));

vi.mock("../use-eval-run-compare", () => ({
  useEvalRunCompare: () => compareState.current,
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "description-experiments-enabled"
      ? descriptionExperimentFlag.current
      : flagEnabled.current,
}));
vi.mock("../use-eval-description-experiment", () => ({
  useEvalDescriptionExperiment: (args: { enabled?: boolean }) => {
    descriptionExperiment.calls.push(args);
    return descriptionExperiment.current;
  },
}));
vi.mock("@/hooks/use-eval-run-stage-analytics", () => ({
  useEvalRunStageAnalytics: () => ({
    ...stageAnalytics.current,
    refetch: () => {},
  }),
}));
// Server quality reaches Convex through `useMutation`, which needs a provider
// this test has no reason to stand up. It is advisory input to the improve
// prompt, never a source of anything the page claims.
vi.mock("../../evals/use-server-quality", () => ({
  useServerQuality: () => serverQuality.current,
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

const DIAGNOSTIC = evalRunDecisionDiagnosticSchema.parse({
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
    analyzerVersion: 8,
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
}) as EvalRunDecisionDiagnostic;

const RUN = {
  _id: "run_1",
  status: "completed",
  result: "failed",
} as unknown as EvalSuiteRun;

const ITERATIONS = [
  {
    _id: "it_1",
    status: "completed",
    result: "failed",
    tokensUsed: 900,
    testCaseId: "case_1",
    testCaseSnapshot: { title: "Draw and share a diagram", caseKey: "hash:a" },
  },
  {
    _id: "it_2",
    status: "completed",
    result: "passed",
    tokensUsed: 900,
    testCaseId: "case_2",
    testCaseSnapshot: { title: "Draw a rectangle", caseKey: "hash:b" },
  },
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
  stageAnalytics.current = {
    status: "absent",
    document: null,
    error: null,
  };
  flagEnabled.current = false;
  descriptionExperimentFlag.current = false;
  serverQuality.current = { result: null };
  descriptionExperiment.calls = [];
  descriptionExperiment.current = {
    status: "idle",
    experiment: null,
    error: null,
    propose: () => Promise.resolve(),
    start: () => Promise.resolve(),
    refetch: () => {},
  };
  compareState.current = { status: "disabled", dto: null, errorKind: null };
  detailState.current = {
    ...detailState.current,
    status: "ready",
    summary: null,
    diagnostics: [],
  };
});

describe("EvaluateRunContent", () => {
  it("mounts findings by default for the displayed run", () => {
    renderContent();
    expect(screen.getByTestId("unified-findings-section")).toHaveAttribute(
      "data-run-id",
      "run_1",
    );
  });

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
    const pairings = screen.getByTestId("run-verdict-pairings");
    expect(within(pairings).getAllByTestId("run-verdict-pairing")).toHaveLength(
      1,
    );
    const row = within(pairings).getByTestId("run-verdict-pairing");
    expect(within(row).getByText("Passed")).toBeVisible();
    expect(within(row).getByText("Failed")).toBeVisible();
    expect(
      within(row).getByTestId("run-verdict-pairing-rate"),
    ).toHaveTextContent("50%");
    expect(within(pairings).queryByText("1 of 2")).toBeNull();
    expect(
      pairings.compareDocumentPosition(
        screen.getByRole("heading", { name: "What broke" }),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByRole("heading", { name: "What broke" })).toHaveClass(
      "text-sm",
      "font-semibold",
    );
    expect(
      screen.getByRole("heading", { name: /How to fix|Next step/ }),
    ).toHaveClass("text-sm", "font-semibold");
    expect(screen.queryByTestId("run-grading-peek")).toBeNull();
    expect(screen.queryByTestId("run-verdict-caveats")).toBeNull();
    // Latency, tokens, and tool calls belong to the pairing that recorded
    // them, not to a page-level strip that averages every client together.
    expect(screen.queryByTestId("run-verdict-stats")).toBeNull();
    for (const label of ["P50", "P95", "Tokens", "Calls"]) {
      expect(within(row).getByText(label)).toBeVisible();
    }
  });

  it.each(["running", "completed"])(
    "pairs fallback comparisons only after the run finishes (%s)",
    (status) => {
      const current = {
        _id: "run_2",
        status,
        result: status === "running" ? "pending" : "failed",
        namedHostId: "host-1",
        effectiveModelId: "sonnet",
        runNumber: 2,
        createdAt: 2_000,
      } as unknown as EvalSuiteRun;
      const previous = {
        _id: "run_1",
        status: "completed",
        result: "failed",
        namedHostId: "host-1",
        effectiveModelId: "sonnet",
        runNumber: 1,
        createdAt: 1_000,
      } as unknown as EvalSuiteRun;
      const previousRows = [
        {
          _id: "prev_1",
          suiteRunId: "run_1",
          result: "failed",
          status: "completed",
        },
        {
          _id: "prev_2",
          suiteRunId: "run_1",
          result: "failed",
          status: "completed",
        },
      ] as unknown as EvalIteration[];

      renderContent({
        run: current,
        iterations: ITERATIONS,
        previousRunId: null,
        siblingRuns: [previous, current],
        allIterations: previousRows,
      });

      if (status === "running") {
        expect(screen.queryByTestId("run-verdict-stat-delta")).toBeNull();
        return;
      }

      // Two failures last time, one pass and one failure now: the row's headline
      // rate moves, and Passed carries the count it moved by.
      expect(screen.getByTestId("run-verdict-pairing-rate")).toHaveTextContent(
        "+50%",
      );
      expect(
        screen
          .getAllByTestId("run-verdict-stat-delta")
          .map((delta) => delta.textContent),
      ).toContain("+1");
    },
  );

  it("says nothing about a verdict while the read is in flight", () => {
    detailState.current = {
      ...detailState.current,
      status: "loading",
      summary: null,
      diagnostics: [],
    };
    renderContent();

    expect(
      screen.getByRole("status", { name: "Loading run summary" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("What happened")).toBeNull();
    // PASS_WORDS alone is too weak here: it does not contain "Failed" or
    // "Inconclusive", so a regression that rendered either while the read was
    // in flight would have passed this test. The claim is that NO verdict word
    // appears at all, so assert the actual word.
    expect(screen.getByTestId("run-verdict-word")).toHaveTextContent(
      /^(Running|Pending|Queued|Cancelled|Did not start|No verdict)$/,
    );
    expect(screen.getByTestId("run-verdict-word").textContent).not.toMatch(
      PASS_WORDS,
    );
    expect(screen.getByTestId("run-verdict-word").textContent).not.toMatch(
      /\b(Failed|Inconclusive)\b/,
    );
    expect(screen.queryByTestId("run-verdict-caveats")).toBeNull();
    expect(screen.queryByTestId("run-grading-peek")).toBeNull();
  });

  it("hides summary cards when the finished read has no summary", () => {
    renderContent();
    expect(screen.queryByTestId("run-summary-loading")).toBeNull();
    expect(screen.queryByText("What happened")).toBeNull();
    expect(screen.queryByText("Next step")).toBeNull();
    expect(screen.queryByTestId("run-grading-peek")).toBeNull();
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
    expect(screen.getByTestId("run-verdict-word").textContent).not.toMatch(
      /\b(Failed|Inconclusive)\b/,
    );
    expect(screen.getByTestId("run-verdict-sentence")).toHaveTextContent(
      "could not be read",
    );
  });

  it("omits the retired bottom sections while keeping the results matrix", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({ fallbackBody: <div>existing run detail</div> });

    expect(screen.queryByText("existing run detail")).toBeNull();
    expect(screen.queryByText("Case diagnostics")).toBeNull();
    expect(screen.queryByText("Worth a look, never required")).toBeNull();
    expect(screen.queryByText("Full run report")).toBeNull();
    expect(screen.queryByTestId("run-stage-strip")).toBeNull();
    expect(screen.getByRole("table")).toBeInTheDocument();
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

  it("says what changed since the previous run", () => {
    compareState.current = {
      status: "ready",
      dto: {
        baseline: { baseRunId: "run_0" },
        baseRun: { id: "run_0", runNumber: 4 },
        compareRun: { id: "run_1", runNumber: 5 },
        cases: [
          {
            caseKey: "hash:a",
            title: "Draw and share a diagram",
            status: "unchanged_failed",
            configChanged: false,
            evaluationConfigChanged: false,
            base: { outcome: "failed", iterationIds: [] },
            compare: { outcome: "failed", iterationIds: [] },
          },
        ],
      },
      errorKind: null,
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();

    expect(screen.getByTestId("run-change-summary")).toHaveTextContent(
      "vs run #4: 1 still failing",
    );
  });

  it("says nothing about change when the comparison did not happen", () => {
    // Never "Unchanged": that is a claim about a comparison, and a failed or
    // absent one supports no claim at all.
    compareState.current = {
      status: "error",
      dto: null,
      errorKind: "noBaseline",
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();

    expect(screen.queryByTestId("run-change-summary")).toBeNull();
    expect(screen.queryByText("Unchanged")).toBeNull();
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

  it("does not query or render a description experiment when the flag is off", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: {
        ...RUN,
        toolSnapshot: {
          servers: [{ tools: [{ name: "export_to_excalidraw" }] }],
        },
      } as EvalSuiteRun,
    });
    expect(descriptionExperiment.calls.at(-1)?.enabled).toBe(false);
    expect(screen.queryByTestId("description-experiment-card")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Propose a description rewrite/ }),
    ).toBeNull();
  });

  it("keeps the description-experiment card without the retired advisory section", () => {
    descriptionExperimentFlag.current = true;
    serverQuality.current = { result: {} };
    descriptionExperiment.current = {
      status: "ready",
      experiment: {
        id: "exp_1",
        suiteId: "suite_1",
        sourceRunId: "run_1",
        toolName: "get_user",
        status: "proposed",
      },
      error: null,
      propose: () => Promise.resolve(),
      start: () => Promise.resolve(),
      refetch: () => {},
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();
    expect(descriptionExperiment.calls.at(-1)?.enabled).toBe(true);
    const card = screen.getByTestId("description-experiment-card");
    expect(card).toBeInTheDocument();
    expect(screen.queryByTestId("run-advisory-section")).toBeNull();
  });
});
