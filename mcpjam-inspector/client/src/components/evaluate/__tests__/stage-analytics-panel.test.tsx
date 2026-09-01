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

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("@/lib/apis/eval-stage-analytics-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-stage-analytics-api")
  >("@/lib/apis/eval-stage-analytics-api");
  return { ...actual, fetchEvalSuiteStageAnalytics: fetchMock };
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
});

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
    expect(detail.textContent).toContain("1 — its stage chain did not validate");
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
