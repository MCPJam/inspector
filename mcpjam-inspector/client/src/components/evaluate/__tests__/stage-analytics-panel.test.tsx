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
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageAnalyticsPanel } from "../stage-analytics-panel";
import {
  GOLDEN_STAGE_ANALYTICS,
  stageAnalyticsVariation,
} from "@/test/stage-analytics-fixtures";
import { readDecisionSummaryFixture } from "@/test/eval-decision-summary-fixtures";
import { evalDecisionSummaryStore } from "@/lib/evals/eval-decision-summary-store";
import { EvalRunDecisionSummaryError } from "@/lib/apis/eval-run-decision-summary-api";

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

const SUITE_ID = GOLDEN_STAGE_ANALYTICS.suiteId;

function renderPanel(
  props: Partial<React.ComponentProps<typeof StageAnalyticsPanel>> = {},
) {
  return render(
    <StageAnalyticsPanel
      projectId="p1"
      suiteId={SUITE_ID}
      runCount={0}
      runsLoading={false}
      {...props}
    />,
  );
}

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

function runRow(status = "completed") {
  return {
    _id: DECISION.runId,
    status,
    result: "failed",
    completedAt: 1_700_000_010_000,
  };
}

describe("StageAnalyticsPanel", () => {
  it("renders the populated document from the golden corpus", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    await screen.findByTestId("stage-analytics-document");

    // The overall funnel, and the marginal slices beside it.
    expect(screen.getByText(/where the chain stopped/i)).toBeTruthy();
    expect(screen.getByText("By intent")).toBeTruthy();
    expect(screen.getByText("By model")).toBeTruthy();
    expect(screen.getByText("By host")).toBeTruthy();
    // The unlabelled intent slice is a real population, rendered as a word.
    expect(screen.getByText("Unlabeled")).toBeTruthy();
    // Six stages in the overall slice, position preserved.
    const slices = screen.getAllByTestId("stage-slice");
    expect(within(slices[0]!).getAllByTestId("stage-row")).toHaveLength(6);
  });

  it("badges a provisional document", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const badge = await screen.findByTestId("stage-analytics-provisional");
    expect(badge.textContent).toMatch(/may change/i);
  });

  it("shows no provisional badge on a final document", async () => {
    fetchMock.mockResolvedValue({
      rows: [stageAnalyticsVariation({ materializationState: "final" })],
    });
    renderPanel();

    await screen.findByTestId("stage-analytics-document");
    expect(screen.queryByTestId("stage-analytics-provisional")).toBeNull();
  });

  it("names the population on the trial count, never calling trials cases", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const doc = await screen.findByTestId("stage-analytics-document");
    expect(doc.textContent).toMatch(/trials in this run/i);
  });

  it("renders a service failure distinctly from an empty result", async () => {
    fetchMock.mockRejectedValue(new Error("upstream down"));
    renderPanel({ runCount: 5 });

    const state = await screen.findByTestId("stage-analytics-unsupported");
    expect(state.textContent).toMatch(/not measured here/i);
    // NOT the empty state, and NOT a chart.
    expect(screen.queryByTestId("stage-analytics-empty")).toBeNull();
    expect(screen.queryByTestId("stage-analytics-document")).toBeNull();
  });

  it("renders pre-analytics runs as unmeasured, not as a zero", async () => {
    fetchMock.mockResolvedValue({ rows: [] });
    renderPanel({ runCount: 12 });

    const state = await screen.findByTestId(
      "stage-analytics-unmeasured-legacy",
    );
    expect(state.textContent).toMatch(/predate stage analytics/i);
    expect(state.textContent).not.toMatch(/0%/);
  });

  it("renders a suite with no runs as validly empty", async () => {
    fetchMock.mockResolvedValue({ rows: [] });
    renderPanel({ runCount: 0 });

    const state = await screen.findByTestId("stage-analytics-empty");
    expect(state.textContent).toMatch(/no completed runs yet/i);
  });

  it("shows a loading state before the first page lands", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderPanel();
    expect(await screen.findByTestId("stage-analytics-loading")).toBeTruthy();
  });

  it("discloses truncation rather than presenting a partial set as complete", async () => {
    fetchMock.mockResolvedValue({
      rows: [
        stageAnalyticsVariation({
          sliceTruncation: [
            { dimension: "model", distinctValues: 40, retained: 25 },
          ],
        }),
      ],
    });
    renderPanel();

    const disclosures = await screen.findByTestId(
      "stage-analytics-disclosures",
    );
    expect(disclosures.textContent).toMatch(/not the complete set/i);
  });

  it("discloses mixed analyzer versions", async () => {
    fetchMock.mockResolvedValue({
      rows: [stageAnalyticsVariation({ sourceStageAnalyzerVersions: [1, 2] })],
    });
    renderPanel();

    const disclosures = await screen.findByTestId(
      "stage-analytics-disclosures",
    );
    expect(disclosures.textContent).toMatch(/mixed stage analyzer/i);
  });

  it("renders setup with its unit and basis", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const setup = await screen.findByTestId("stage-analytics-setup");
    expect(setup.textContent).toMatch(/Connection/);
    // Impacted trials are counted separately from attempts.
    expect(setup.textContent).toMatch(/blocking \d+ trials in this run/i);
  });

  it("renders words, not a percentage, for a stage with nothing to divide", async () => {
    // Every stage tally zeroed: applicable 0 everywhere, so every rate is
    // notMeasured and NOT a 0%.
    const emptyStages = structuredClone(GOLDEN_STAGE_ANALYTICS);
    for (const slice of emptyStages.slices) {
      slice.includedTrials = 0;
      slice.failureCategories = [];
      for (const stage of slice.stages) {
        Object.assign(stage, {
          applicable: 0,
          reached: 0,
          notReached: 0,
          reachUnknown: 0,
          measured: 0,
          passed: 0,
          failed: 0,
          notMeasured: 0,
          notApplicable: 0,
          reasons: [],
        });
        delete (stage as { latency?: unknown }).latency;
      }
    }
    emptyStages.includedTrials = 0;
    fetchMock.mockResolvedValue({
      rows: [stageAnalyticsVariation(emptyStages)],
    });
    renderPanel();

    const doc = await screen.findByTestId("stage-analytics-document");
    expect(within(doc).getAllByText("not measured").length).toBeGreaterThan(0);
    expect(doc.textContent).not.toMatch(/\b0%/);
  });

  it("renders stage reasons in words, one line each, never a wire enum", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const doc = await screen.findByTestId("stage-analytics-document");
    // The golden document's `selection` row carries `missingToolCall (1)`.
    expect(doc.textContent).toContain(
      "1 — an expected tool call was never made",
    );
    // The bug this fixes: the raw enum on screen. The wire spelling survives
    // only as a `data-` attribute, which is not text a reader sees.
    expect(doc.textContent).not.toContain("missingToolCall");
    expect(
      within(doc).getAllByTestId("stage-reasons")[0]!.querySelector("li")
        ?.dataset.reason,
    ).toBe("missingToolCall");
  });

  it("renders failure categories in words", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const doc = await screen.findByTestId("stage-analytics-document");
    const categories = within(doc).getAllByTestId(
      "stage-slice-failure-categories",
    );
    expect(categories[0]!.textContent).toBe("tool selection (1)");
  });

  it("keeps the fine-grained exclusion detail behind a collapsed disclosure", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const detail = await screen.findByTestId("stage-analytics-excluded-detail");
    // COLLAPSED: the coarse line is already in the disclosures above, and this
    // says the same trials over again at a finer grain.
    expect((detail as HTMLDetailsElement).open).toBe(false);
    // The population comes before the reasons.
    expect(detail.textContent).toContain("3 of 7 trials excluded");

    await userEvent.click(within(detail).getByText(/3 of 7 trials excluded/));
    expect((detail as HTMLDetailsElement).open).toBe(true);
    expect(detail.textContent).toContain("1 — cancelled before it finished");
    expect(detail.textContent).toContain(
      "1 — its stage chain did not validate",
    );
    expect(detail.textContent).not.toContain("chainUnverified");
  });

  it("omits the exclusion disclosure entirely when nothing was excluded", async () => {
    // A control that opens onto nothing is a worse answer than no control.
    fetchMock.mockResolvedValue({
      rows: [
        stageAnalyticsVariation({
          excludedTrialDetail: {},
          excludedTrials: {},
          includedTrials: 4,
          totalTrials: 4,
        }),
      ],
    });
    renderPanel();

    await screen.findByTestId("stage-analytics-document");
    expect(screen.queryByTestId("stage-analytics-excluded-detail")).toBeNull();
  });

  it("draws the six stage cards, in chain order, with an arrow between them", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const row = await screen.findByTestId("stage-chain-cards");
    for (const stage of [
      "connection",
      "discovery",
      "selection",
      "call",
      "response",
      "userValue",
    ]) {
      expect(within(row).getByTestId(`stage-chain-card-${stage}`)).toBeTruthy();
    }
    // Five separators for six cards, and every one of them decoration.
    const arrows = row.querySelectorAll('[aria-hidden="true"]');
    expect(arrows).toHaveLength(5);
  });

  it("auto-selects the first break in the chain", async () => {
    // The golden document fails one trial at `selection`; the `notReached` at
    // `call` after it is a CONSEQUENCE, not a second finding.
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const detail = await screen.findByTestId("stage-detail-card");
    expect(detail.dataset.stage).toBe("selection");
    expect(
      screen
        .getByTestId("stage-chain-card-selection")
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // The stage's QUESTION, from the contract's own map.
    expect(detail.textContent).toContain(
      "Did the model choose the right tool for the request?",
    );
  });

  it("swaps the detail card when another stage is clicked", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    await screen.findByTestId("stage-detail-card");
    await userEvent.click(screen.getByTestId("stage-chain-card-connection"));

    const detail = screen.getByTestId("stage-detail-card");
    expect(detail.dataset.stage).toBe("connection");
    expect(detail.textContent).toContain(
      "Could the client reach the server and initialize a session?",
    );
    expect(
      screen
        .getByTestId("stage-chain-card-selection")
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("closes the detail when the open card is clicked again", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    await screen.findByTestId("stage-detail-card");
    await userEvent.click(screen.getByTestId("stage-chain-card-selection"));
    expect(screen.queryByTestId("stage-detail-card")).toBeNull();
  });

  it("opens no detail card on a run with nothing broken", async () => {
    // Nothing broken means no "what happened" to answer, and auto-opening a
    // card anyway would manufacture a question the run did not raise.
    const clean = structuredClone(GOLDEN_STAGE_ANALYTICS);
    for (const slice of clean.slices) {
      for (const stage of slice.stages) {
        Object.assign(stage, {
          applicable: 2,
          reached: 2,
          notReached: 0,
          reachUnknown: 0,
          measured: 2,
          passed: 2,
          failed: 0,
          notMeasured: 0,
          notApplicable: 0,
          excluded: {},
          reasons: [],
        });
      }
      slice.includedTrials = 2;
      slice.failureCategories = [];
    }
    clean.includedTrials = 2;
    fetchMock.mockResolvedValue({ rows: [stageAnalyticsVariation(clean)] });
    renderPanel();

    await screen.findByTestId("stage-chain-cards");
    expect(screen.queryByTestId("stage-detail-card")).toBeNull();
    // A passing card reads as the delivery story, not as a bare "passed".
    expect(
      screen.getByTestId("stage-chain-card-response").textContent,
    ).toContain("Usable response returned");
  });

  it("never puts a pass word on a stage that measured nothing", async () => {
    const unmeasured = structuredClone(GOLDEN_STAGE_ANALYTICS);
    for (const slice of unmeasured.slices) {
      for (const stage of slice.stages) {
        Object.assign(stage, {
          applicable: 3,
          reached: 0,
          notReached: 0,
          reachUnknown: 3,
          measured: 0,
          passed: 0,
          failed: 0,
          notMeasured: 0,
          notApplicable: 0,
          excluded: { reachUnknown: 3 },
          reasons: [],
        });
        delete (stage as { latency?: unknown }).latency;
      }
      slice.includedTrials = 3;
      slice.failureCategories = [];
    }
    unmeasured.includedTrials = 3;
    fetchMock.mockResolvedValue({
      rows: [stageAnalyticsVariation(unmeasured)],
    });
    renderPanel();

    const row = await screen.findByTestId("stage-chain-cards");
    expect(row.textContent).toContain("nothing captured — reach undecidable");
    expect(row.textContent).not.toMatch(/\bpassed\b/);
    expect(row.textContent).not.toContain("Usable response returned");
  });

  it("states the D9/D5c boundary in the UI's own words", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    const doc = await screen.findByTestId("stage-analytics-document");
    expect(doc.textContent).toContain(
      "Stage health explains the request-delivery path; it does not determine the evaluation verdict.",
    );
  });

  it("keeps the marginals and setup collapsed, with their markup unchanged", async () => {
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    renderPanel();

    await screen.findByTestId("stage-analytics-document");
    for (const id of [
      "stage-slice-group-By intent",
      "stage-slice-group-By model",
      "stage-slice-group-By host",
      "stage-analytics-setup",
      "stage-analytics-overall-rows",
    ]) {
      expect((screen.getByTestId(id) as HTMLDetailsElement).open).toBe(false);
    }
    // The existing markup still renders inside — the honesty-rule assertions
    // above pin the same `data-testid`s they always did.
    expect(screen.getAllByTestId("stage-slice").length).toBeGreaterThan(1);
    expect(
      within(screen.getAllByTestId("stage-slice")[0]!).getAllByTestId(
        "stage-row",
      ),
    ).toHaveLength(6);
  });

  it("lists runs and loads more without dropping the current view", async () => {
    const second = stageAnalyticsVariation({
      runId: "run_second",
      runCompletedAt: 1600000000000,
    });
    fetchMock
      .mockResolvedValueOnce({
        rows: [GOLDEN_STAGE_ANALYTICS],
        nextCursor: "c2",
      })
      .mockResolvedValueOnce({ rows: [second] });

    renderPanel();
    const button = await screen.findByTestId("stage-analytics-load-more");
    await userEvent.click(button);

    await waitFor(() =>
      expect(screen.getByTestId("stage-analytics-run-list")).toBeTruthy(),
    );
    // Still showing the newest run's document, with the older one selectable.
    expect(screen.getByTestId("stage-analytics-document")).toBeTruthy();
  });
});

describe("stage findings — the evidence behind a stage's failures", () => {
  it("joins D9's trials onto the selected stage, with the trial's own error text", async () => {
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    decisionFetchMock.mockResolvedValue(DECISION);
    renderPanel({
      runs: [runRow()],
      decisionSummaryEnabled: true,
      onRunClick: () => {},
    });

    const findings = await screen.findByTestId("stage-findings");
    // Population before anything else, and the tally's own denominator.
    expect(findings.textContent).toMatch(/failed in \d+ of \d+ measured/);
    // The corpus's selection trial, its reason, and its observed failure.
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
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    decisionFetchMock.mockResolvedValue(DECISION);
    renderPanel({
      runs: [runRow()],
      decisionSummaryEnabled: true,
      onRunClick: () => {},
    });

    await screen.findByTestId("stage-findings");
    await userEvent.click(screen.getByTestId("stage-chain-card-connection"));

    expect(screen.getByTestId("stage-finding-observed").textContent).toContain(
      "the connection stage did not hold",
    );
  });

  it("offers OPEN RUN on the suite page, where no deep trace focus exists", async () => {
    const opened: string[] = [];
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    decisionFetchMock.mockResolvedValue(DECISION);
    renderPanel({
      runs: [runRow()],
      decisionSummaryEnabled: true,
      onRunClick: (runId: string) => opened.push(runId),
    });

    const open = await screen.findByTestId("stage-finding-open");
    // NOT "View trace": a button promising deep focus here would land a reader
    // on a page with nothing opened.
    expect(open.textContent).toContain("Open run");
    await userEvent.click(open);
    expect(opened).toEqual([DECISION.runId]);
  });

  it("issues NO decision request when the flag is off", async () => {
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    renderPanel({ runs: [runRow()], decisionSummaryEnabled: false });

    await screen.findByTestId("stage-chain-cards");
    expect(decisionFetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("stage-findings")).toBeNull();
  });

  it("issues NO decision request for a run that has not finished", async () => {
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    renderPanel({
      runs: [runRow("running")],
      decisionSummaryEnabled: true,
    });

    await screen.findByTestId("stage-chain-cards");
    expect(decisionFetchMock).not.toHaveBeenCalled();
  });

  it("says an unreadable page is unreadable, and keeps the rates on screen", async () => {
    fetchMock.mockResolvedValue({ rows: [joinedAnalytics()] });
    decisionFetchMock.mockRejectedValue(
      new EvalRunDecisionSummaryError("requestFailed", "upstream down"),
    );
    renderPanel({ runs: [runRow()], decisionSummaryEnabled: true });

    const unavailable = await screen.findByTestId("stage-findings-unavailable");
    expect(unavailable.textContent).toMatch(/couldn't load/i);
    // A stage's measured rates are true whether or not a diagnostics page
    // arrived, so they stay.
    expect(screen.getByTestId("stage-detail-card").textContent).toMatch(
      /Measured pass/,
    );
    // And it never reads as a finding about the server.
    expect(unavailable.textContent).not.toMatch(/0 failures|no failures/i);
  });

  it("renders nothing at all when the two documents describe different runs", async () => {
    // A mid-navigation frame, which resolves itself on the next tick.
    fetchMock.mockResolvedValue({ rows: [GOLDEN_STAGE_ANALYTICS] });
    decisionFetchMock.mockResolvedValue(DECISION);
    renderPanel({
      runs: [{ ...runRow(), _id: GOLDEN_STAGE_ANALYTICS.runId }],
      decisionSummaryEnabled: true,
    });

    await screen.findByTestId("stage-chain-cards");
    await waitFor(() =>
      expect(screen.queryByTestId("stage-findings")).toBeNull(),
    );
    expect(screen.queryByTestId("stage-findings-unavailable")).toBeNull();
  });
});
