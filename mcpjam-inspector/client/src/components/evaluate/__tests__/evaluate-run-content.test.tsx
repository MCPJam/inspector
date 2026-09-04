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
import userEvent from "@testing-library/user-event";
import {
  buildEvalRunRouteFacts,
  evalCaseAggregationKey,
  evalRunDecisionDiagnosticSchema,
  evalRunDecisionSummaryStructuralSchema,
  type EvalRunDecisionDiagnostic,
  type EvalRunDecisionSummary,
  type EvalRunRouteFacts,
} from "@mcpjam/sdk/contract";

import { GOLDEN_STAGE_ANALYTICS } from "@/test/stage-analytics-fixtures";
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

const stageAnalytics = vi.hoisted(() => ({
  current: {
    status: "absent" as string,
    document: null as unknown,
    error: null,
  },
}));
const routeFacts = vi.hoisted(() => ({
  current: {
    status: "absent" as string,
    document: null as unknown,
    error: null,
  },
}));
const flagEnabled = vi.hoisted(() => ({ current: false }));
const routeFactsFlag = vi.hoisted(() => ({ current: false }));
const descriptionExperimentFlag = vi.hoisted(() => ({ current: false }));
const failureGroupsFlag = vi.hoisted(() => ({ current: false }));
const failureGroups = vi.hoisted(() => ({
  calls: [] as Array<{ enabled?: boolean; suiteId?: string }>,
  current: {
    latest: null as unknown,
    inFlight: null as unknown,
    loading: false,
    requesting: false,
    error: null as string | null,
    request: () => Promise.resolve(),
  },
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
    flag === "evaluate-route-facts-enabled"
      ? routeFactsFlag.current
      : flag === "description-experiments-enabled"
        ? descriptionExperimentFlag.current
        : flag === "evaluate-failure-groups-enabled"
          ? failureGroupsFlag.current
          : flagEnabled.current,
}));
vi.mock("@/hooks/use-suite-failure-groups", () => ({
  useSuiteFailureGroups: (args: { enabled?: boolean; suiteId?: string }) => {
    failureGroups.calls.push(args);
    return failureGroups.current;
  },
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
vi.mock("@/hooks/use-eval-run-route-facts", () => ({
  useEvalRunRouteFacts: () => ({
    ...routeFacts.current,
    refetch: () => {},
  }),
}));

// Server quality reaches Convex through `useMutation`, which needs a provider
// this test has no reason to stand up. It is advisory input to the improve
// prompt, never a source of anything the page claims.
vi.mock("../../evals/use-server-quality", () => ({
  useServerQuality: () => ({ result: null }),
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
  routeFacts.current = {
    status: "absent",
    document: null,
    error: null,
  };
  flagEnabled.current = false;
  routeFactsFlag.current = false;
  descriptionExperimentFlag.current = false;
  failureGroupsFlag.current = false;
  failureGroups.calls = [];
  failureGroups.current = {
    latest: null,
    inFlight: null,
    loading: false,
    requesting: false,
    error: null,
    request: () => Promise.resolve(),
  };
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
    // The expected/observed pair is a peek under the sentence, not the
    // counting caveats and not the hero. The open case row repeats both names
    // in its own evidence block, which is intended, so queries are scoped.
    const peek = screen.getByTestId("run-grading-peek");
    expect(peek).toHaveTextContent("Graded against");
    expect(within(peek).getByText("create_view")).toBeInTheDocument();
    expect(
      within(peek).getByText("never called").closest("li"),
    ).toHaveTextContent("export_to_excalidraw never called");
    expect(screen.getByTestId("run-verdict-hero")).not.toHaveTextContent(
      "Expected",
    );
    expect(screen.getByTestId("run-verdict-caveats")).not.toHaveTextContent(
      "export_to_excalidraw",
    );
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

  it("says when stage measurements were not recorded", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();
    expect(screen.getByTestId("run-stage-strip")).toHaveTextContent(
      "Stage measurements were not recorded for this run",
    );
  });

  it("filters the case rows to the stage a reader picks", async () => {
    flagEnabled.current = true;
    stageAnalytics.current = {
      status: "ready",
      document: GOLDEN_STAGE_ANALYTICS,
      error: null,
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();

    expect(screen.getByTestId("run-stage-strip")).toBeInTheDocument();
    // The one case in this fixture broke at selection, so filtering to a stage
    // nothing broke at must leave the list empty rather than showing it anyway.
    await userEvent.click(screen.getByTestId("run-stage-strip-cell-discovery"));
    expect(
      screen.getByText("This run has no cases to show."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("run-stage-strip-cell-selection"));
    expect(screen.getByTestId("run-case-rows")).toHaveTextContent(
      "Draw and share a diagram",
    );
    // And only that one: the passing case did not break at selection.
    expect(screen.getByTestId("run-case-rows")).not.toHaveTextContent(
      "Draw a rectangle",
    );
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

  it("renders the description-experiment card above the advisory section when the flag is on", () => {
    descriptionExperimentFlag.current = true;
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
    const body = screen.getByTestId("evaluate-run-content");
    const advisory = screen.queryByTestId("run-advisory-section");
    if (advisory) {
      expect(
        body.compareDocumentPosition(advisory) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("does not query or render failure groups when the flag is off", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: { ...RUN, suiteId: "suite_1" } as EvalSuiteRun,
    });
    expect(failureGroups.calls).toEqual([]);
    expect(screen.queryByTestId("failure-groups-card")).toBeNull();
  });

  it("renders the failure-groups card below the advisory section when the flag is on", () => {
    failureGroupsFlag.current = true;
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: { ...RUN, suiteId: "suite_1" } as EvalSuiteRun,
    });
    const card = screen.getByTestId("failure-groups-card");
    expect(card).toBeInTheDocument();
    const advisory = screen.queryByTestId("run-advisory-section");
    if (advisory) {
      expect(
        card.compareDocumentPosition(advisory) & Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
    }
  });

  it("discloses a rewritten description on the rewrite-arm run", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: {
        ...RUN,
        configSnapshot: {
          tests: [],
          environment: { servers: [] },
          toolDescriptionOverride: {
            toolName: "get_user",
            description: "rewritten",
            proposalHash: "p1",
            experimentId: "exp_1",
            originalDescriptionHash: "o1",
          },
        },
      } as EvalSuiteRun,
    });
    expect(
      screen.getByText(/this run deliberately rewrote the description of/),
    ).toBeInTheDocument();
  });

  it("does not compute or render route facts when the flag is off", () => {
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent();
    expect(screen.queryByTestId("route-facts-section")).toBeNull();
    expect(screen.queryByTestId("route-line-case_1")).toBeNull();
  });

  it("renders route facts on the default-open failing row when the flag is on", () => {
    routeFactsFlag.current = true;
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: {
        ...RUN,
        suiteId: "suite_1",
        toolSnapshot: {
          servers: [
            {
              tools: [
                { name: "export_to_excalidraw" },
                { name: "create_view" },
              ],
            },
          ],
        },
      } as EvalSuiteRun,
      iterations: [
        {
          ...ITERATIONS[0],
          actualToolCalls: [{ toolName: "create_view", arguments: {} }],
          testCaseSnapshot: {
            title: "Draw and share a diagram",
            caseKey: "hash:a",
            query: "q",
            provider: "anthropic",
            model: "claude",
            expectedToolCalls: [
              { toolName: "export_to_excalidraw", arguments: {} },
            ],
          },
        },
        ITERATIONS[1],
      ] as EvalIteration[],
    });

    expect(screen.getByTestId("route-facts-section")).toBeInTheDocument();
    expect(screen.getByText("Routes")).toBeInTheDocument();
    expect(screen.getByText("Expected vs observed")).toBeInTheDocument();
  });

  const ROUTE_FACTS_RUN = {
    ...RUN,
    suiteId: "suite_1",
    toolSnapshot: {
      servers: [
        {
          tools: [
            { name: "export_to_excalidraw" },
            { name: "create_view" },
          ],
        },
      ],
    },
  } as EvalSuiteRun;

  const ROUTE_FACTS_ITERATIONS = [
    {
      ...ITERATIONS[0],
      actualToolCalls: [{ toolName: "create_view", arguments: {} }],
      testCaseSnapshot: {
        title: "Draw and share a diagram",
        caseKey: "hash:a",
        query: "q",
        provider: "anthropic",
        model: "claude",
        expectedToolCalls: [
          { toolName: "export_to_excalidraw", arguments: {} },
        ],
      },
    },
    ITERATIONS[1],
  ] as EvalIteration[];

  function persistedRouteFactsDoc(): EvalRunRouteFacts {
    return buildEvalRunRouteFacts({
      run: {
        runId: "run_1",
        suiteId: "suite_1",
        materializationState: "final",
        now: 0,
      },
      trials: [
        {
          trialKey: "it_1",
          status: "completed",
          result: "failed",
          actualToolCalls: [
            { toolName: "persisted_search" },
            { toolName: "persisted_get" },
          ],
          expectedToolCalls: [{ toolName: "export_to_excalidraw" }],
          caseVariantKey: evalCaseAggregationKey({
            caseId: "hash:a",
            executionVariant: { model: "claude", provider: "anthropic" },
          }),
          caseKey: "hash:a",
          executionVariant: { model: "claude", provider: "anthropic" },
        },
      ],
      catalog: {
        state: "loaded",
        toolNames: [
          "persisted_search",
          "persisted_get",
          "export_to_excalidraw",
        ],
      },
    });
  }

  it("prefers the persisted route-facts document when the hook is ready", () => {
    routeFactsFlag.current = true;
    routeFacts.current = {
      status: "ready",
      document: persistedRouteFactsDoc(),
      error: null,
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: ROUTE_FACTS_RUN,
      iterations: ROUTE_FACTS_ITERATIONS,
    });

    const section = screen.getByTestId("route-facts-section");
    expect(section).toHaveTextContent("persisted_search→persisted_get");
    expect(section).not.toHaveTextContent("create_view");
    expect(screen.queryByText("computed here")).toBeNull();
  });

  it("falls back to local route facts when the persisted document is absent", () => {
    routeFactsFlag.current = true;
    routeFacts.current = {
      status: "absent",
      document: null,
      error: null,
    };
    detailState.current = {
      ...detailState.current,
      status: "ready",
      summary: summary(),
      diagnostics: [DIAGNOSTIC],
    };
    renderContent({
      run: ROUTE_FACTS_RUN,
      iterations: ROUTE_FACTS_ITERATIONS,
    });

    const section = screen.getByTestId("route-facts-section");
    expect(section).toHaveTextContent("create_view");
    expect(section).not.toHaveTextContent("persisted_search→persisted_get");
    expect(screen.getByText("computed here")).toBeInTheDocument();
  });
});
