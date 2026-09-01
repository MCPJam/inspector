/**
 * The "What happened" card, at its edges.
 *
 * The panel's integration test opens this card on a populated document; these
 * pin the branches that document does not reach — an absent latency aggregate,
 * a stage with no reasons, no findings slot, and a findings node that is itself
 * an error message. Each one is a case where rendering something plausible
 * instead of nothing would be a claim the run never made.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { EvalStageTally } from "@mcpjam/sdk/contract";
import { StageDetailCard } from "../stage-detail-card";
import { toStageRowView } from "../stage-analytics-model";

function rowFor(overrides: Partial<EvalStageTally> = {}) {
  return toStageRowView({
    stage: "response",
    applicable: 4,
    reached: 4,
    notReached: 0,
    reachUnknown: 0,
    measured: 4,
    passed: 3,
    failed: 1,
    notMeasured: 0,
    notApplicable: 0,
    excluded: {},
    reasons: [{ reason: "toolError", count: 1 }],
    latency: {
      unit: "ms",
      basis: "evidence_span_union",
      sampleCount: 2,
      totalMs: 300,
    },
    ...overrides,
  } as EvalStageTally);
}

describe("StageDetailCard", () => {
  it("renders the stage, its question, its three rates and its reasons", () => {
    render(<StageDetailCard stage={rowFor()} />);

    const card = screen.getByTestId("stage-detail-card");
    expect(card.dataset.stage).toBe("response");
    expect(card.textContent).toContain("What happened");
    expect(card.textContent).toContain("Response");
    // The QUESTION comes from the contract's own map, not from this file.
    expect(card.textContent).toContain(
      "Did the server return data the model could use?",
    );
    // All three rates, in the order that qualifies one another.
    expect(card.textContent).toContain("Reach");
    expect(card.textContent).toContain("Measurement coverage");
    expect(card.textContent).toContain("Measured pass");
    expect(card.textContent).toContain("75% (3/4)");
    // The reason in WORDS, with the wire spelling only as an attribute.
    const reasons = within(card).getByTestId("stage-detail-reasons");
    expect(reasons.textContent).toContain(
      "1 — the server reported a tool error",
    );
    expect(reasons.textContent).not.toContain("toolError");
    expect(reasons.querySelector("li")?.dataset.reason).toBe("toolError");
  });

  it("carries the latency's unit AND basis", () => {
    render(<StageDetailCard stage={rowFor()} />);
    // A duration without its basis is a claim, not a measurement.
    expect(screen.getByTestId("stage-detail-card").textContent).toContain(
      "150 ms · evidence span union",
    );
  });

  it("shows NO latency line when there are no samples", () => {
    // Absent, never `0 ms`: a mean of no samples is not a fast server.
    // `latency: null` IS the no-samples case: `StageRowView.latency` is the
    // already-formatted string, and `formatLatency` returns null rather than
    // "0 ms" when the aggregate has no samples.
    render(<StageDetailCard stage={{ ...rowFor(), latency: null }} />);

    expect(screen.getByTestId("stage-detail-card").textContent).not.toMatch(
      /\bms\b/,
    );
  });

  it("omits the reasons list entirely when the stage recorded none", () => {
    render(<StageDetailCard stage={rowFor({ reasons: [] })} />);
    expect(screen.queryByTestId("stage-detail-reasons")).toBeNull();
  });

  it("renders words, not a zero, for a stage with nothing to divide", () => {
    const unmeasured = rowFor({
      applicable: 3,
      reached: 0,
      notReached: 0,
      reachUnknown: 3,
      measured: 0,
      passed: 0,
      failed: 0,
      notMeasured: 0,
      reasons: [],
      excluded: { reachUnknown: 3 },
    });
    render(<StageDetailCard stage={{ ...unmeasured, latency: null }} />);

    const card = screen.getByTestId("stage-detail-card");
    expect(within(card).getAllByText("not measured").length).toBeGreaterThan(0);
    expect(card.textContent).not.toMatch(/\b0%/);
    // The two facts that are not drop-offs are still said out loud.
    expect(card.textContent).toContain("reach undecidable");
  });

  it("renders completely with no findings slot at all", () => {
    // A stage's measured rates are true whether or not a diagnostics page
    // arrived, so the card must not depend on one.
    render(<StageDetailCard stage={rowFor()} />);
    const card = screen.getByTestId("stage-detail-card");
    expect(card.textContent).toContain("Measured pass");
    expect(within(card).queryByTestId("stage-findings")).toBeNull();
  });

  it("passes a findings node through verbatim, error copy included", () => {
    render(
      <StageDetailCard
        stage={rowFor()}
        findings={
          <p data-testid="stage-findings-unavailable">
            Couldn&apos;t load the trial evidence
          </p>
        }
      />,
    );

    const card = screen.getByTestId("stage-detail-card");
    expect(
      within(card).getByTestId("stage-findings-unavailable").textContent,
    ).toContain("Couldn't load the trial evidence");
    // The rates stay beside it — the slot never replaces the measurement.
    expect(card.textContent).toContain("75% (3/4)");
  });
});
