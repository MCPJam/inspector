/**
 * The stage-analytics panel's rendered states.
 *
 * Populated fixtures come from the SDK's GOLDEN corpus, never a local copy, so
 * a change to what a stage funnel means shows up here as a failing render. The
 * states the golden document does not itself carry — truncation, mixed
 * versions, a `final` row — are built as schema-validated variations of it.
 *
 * The assertions are mostly about states being TOLD APART: a service failure
 * must not look like an empty result, and pre-analytics runs must not look
 * like a funnel of zeros.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import { evalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";
import { RunDocument } from "../stage-analytics-panel";
import { StageFindingsCard } from "../stage-findings-card";
import { buildStageFindings } from "../stage-findings-model";

const { fetchMock, decisionFetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  decisionFetchMock: vi.fn(),
}));
vi.mock("@/lib/apis/eval-stage-analytics-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-stage-analytics-api")
  >("@/lib/apis/eval-stage-analytics-api");
  return { ...actual, fetchEvalSuiteStageAnalytics: fetchMock };
});
vi.mock("@/lib/apis/eval-run-decision-summary-api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/apis/eval-run-decision-summary-api")
    >();
  return { ...actual, fetchEvalRunDecisionSummary: decisionFetchMock };
});

beforeEach(() => {
  fetchMock.mockReset();
  decisionFetchMock.mockReset();
  evalDecisionSummaryStore.reset();
});

/**
 * A run row for the selected document, and a decision summary about it.
 *
 * The corpus's summary names `run-1`, so the analytics document is retitled
 * onto it — the join asserts on IDENTITY first, and two documents about two
 * different runs would render as nothing.
 */
const DECISION = readDecisionSummaryFixture("measured-failure-at-every-stage");

function joinedAnalytics() {
  return stageAnalyticsVariation({
    ...structuredClone(GOLDEN_STAGE_ANALYTICS),
    runId: DECISION.runId,
  });
}




/**
 * The findings a stage carries, as the RUN PAGE composes them.
 *
 * These used to run through the suite page's panel, which owned the D9 read
 * and passed the card down. That panel is gone; the surviving composition is
 * `RunDocument` + a `renderFindings` slot, which is what the run detail view
 * builds. So the same claims are asserted against that pair directly — the
 * point was never the panel, it was that a stage's evidence is its OWN and
 * moves when the selection does.
 */
describe("stage findings — the evidence behind a stage's failures", () => {
  function findingsState() {
    return buildStageFindings({
      analytics: joinedAnalytics(),
      summary: DECISION,
      diagnostics: DECISION.diagnostics.items,
      scannedIterations: DECISION.diagnostics.scannedIterations,
      serverComplete: DECISION.diagnostics.complete,
      walkExhausted: true,
      status: "ready",
      error: null,
      runTerminal: true,
      canViewTrace: true,
    });
  }

  function renderRun(
    state = findingsState(),
    onOpenTrial?: (target: { runId: string }) => void,
  ) {
    return render(
      <RunDocument
        row={joinedAnalytics()}
        renderFindings={(stage) => (
          <StageFindingsCard
            state={state}
            stage={stage}
            openLabel="View trace"
            {...(onOpenTrial ? { onOpenTrial } : {})}
          />
        )}
      />,
    );
  }

  it("joins D9's trials onto the selected stage, with the trial's own error text", () => {
    renderRun();

    const findings = screen.getByTestId("stage-findings");
    // Population before anything else, and the tally's own denominator.
    expect(findings.textContent).toMatch(/failed in \d+ of \d+ measured/);
    const group = within(findings).getByTestId("stage-finding-group");
    expect(group.dataset.reason).toBeTruthy();
    expect(
      within(findings).getByTestId("stage-finding-observed").textContent,
    ).toContain("the selection stage did not hold");
    // The loop closes: the diagnostic's own nextAction, no new vocabulary.
    expect(
      within(findings).getByTestId("stage-finding-next-action").textContent,
    ).toContain("Next:");
  });

  it("moves the evidence when another stage is selected", async () => {
    renderRun();
    await userEvent.click(screen.getByTestId("stage-chain-card-connection"));

    expect(screen.getByTestId("stage-finding-observed").textContent).toContain(
      "the connection stage did not hold",
    );
  });

  it("offers the caller's own affordance on a trial", async () => {
    const opened: string[] = [];
    renderRun(findingsState(), (target) => opened.push(target.runId));

    await userEvent.click(screen.getByTestId("stage-finding-open"));
    expect(opened).toEqual([DECISION.runId]);
  });

  it("says an unreadable page is unreadable, and keeps the rates on screen", () => {
    renderRun(
      buildStageFindings({
        analytics: joinedAnalytics(),
        summary: null,
        diagnostics: [],
        scannedIterations: 0,
        serverComplete: false,
        walkExhausted: false,
        status: "error",
        error: {
          title: "Couldn't load the trial evidence",
          detail: "The read did not complete.",
        },
        runTerminal: true,
        canViewTrace: false,
      }),
    );

    expect(screen.getAllByTestId("stage-findings-unavailable").length).toBeGreaterThan(0);
    // A failed evidence read says nothing about the rates, which came from a
    // different document and are still true.
    expect(screen.getByTestId("stage-analytics-document")).toBeTruthy();
  });

  it("renders nothing at all when the two documents describe different runs", () => {
    renderRun(
      buildStageFindings({
        analytics: stageAnalyticsVariation({
          ...structuredClone(GOLDEN_STAGE_ANALYTICS),
          runId: "some-other-run",
        }),
        summary: DECISION,
        diagnostics: DECISION.diagnostics.items,
        scannedIterations: DECISION.diagnostics.scannedIterations,
        serverComplete: DECISION.diagnostics.complete,
        walkExhausted: true,
        status: "ready",
        error: null,
        runTerminal: true,
        canViewTrace: true,
      }),
    );

    // A mid-navigation frame, not an error: it resolves itself on the next
    // tick, and an alarm for it would train a reader to ignore alarms.
    expect(screen.queryByTestId("stage-findings")).toBeNull();
    expect(screen.queryByTestId("stage-findings-unavailable")).toBeNull();
  });
});
