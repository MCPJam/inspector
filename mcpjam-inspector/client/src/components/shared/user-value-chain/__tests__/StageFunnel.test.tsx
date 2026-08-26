/**
 * The funnel.
 *
 * Four rules, four blocks. Each is a way a funnel can report a number that
 * reads as a finding and is not one.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StageFunnel } from "../StageFunnel";
import type {
  ChatSessionStageFunnel,
  StageTally,
} from "../user-value-chain-types";

const STAGES = [
  "connection",
  "discovery",
  "selection",
  "call",
  "response",
  "userValue",
] as const;

function tally(over: Partial<StageTally> & { stage: StageTally["stage"] }) {
  const base: StageTally = {
    stage: over.stage,
    passed: 0,
    failed: 0,
    eligible: 0,
    notMeasured: 0,
    notApplicable: 0,
    notReached: 0,
    observations: 0,
    passRate: null,
  };
  const merged = { ...base, ...over };
  merged.eligible = merged.passed + merged.failed;
  merged.passRate =
    merged.eligible > 0 ? merged.passed / merged.eligible : null;
  return merged;
}

function funnel(
  over: Partial<ChatSessionStageFunnel> = {}
): ChatSessionStageFunnel {
  return {
    source: "user_testing",
    total: 7,
    counted: 7,
    exclusions: { absent: 0, deriving: 0, stale: 0, failed: 0 },
    stages: STAGES.map((stage) =>
      tally({ stage, passed: 4, failed: 3, observations: 7 })
    ),
    firstFailedStage: {},
    notMeasured: false,
    truncated: false,
    ...over,
  };
}

const renderFunnel = (summary: ChatSessionStageFunnel) =>
  render(
    <StageFunnel
      summary={summary}
      title="User value chain"
      populationLabel="Real User Testing sessions"
    />
  );

describe("rule 1 — the counts travel with the rate", () => {
  it("shows the numerator and the eligible denominator, not just a percent", () => {
    renderFunnel(funnel());
    // "57% of seven" and "57% of seven hundred" are not the same finding.
    expect(screen.getAllByText("(4/7 eligible)").length).toBe(6);
    expect(screen.getAllByText("57%").length).toBe(6);
  });

  it("names the population it is over", () => {
    renderFunnel(funnel());
    expect(document.body.textContent).toContain("Real User Testing sessions");
    expect(document.body.textContent).toContain("7 of 7 sessions measured");
  });
});

describe("rule 2 — zero eligible is words, never 0%", () => {
  const unmeasured = funnel({
    stages: STAGES.map((stage) =>
      tally({ stage, notMeasured: 7, observations: 7 })
    ),
  });

  it("renders 'not measured' and no bar", () => {
    const { container } = renderFunnel(unmeasured);
    expect(screen.getAllByText("not measured").length).toBe(6);
    expect(document.body.textContent).not.toContain("0%");
    expect(container.querySelectorAll(".bg-emerald-500")).toHaveLength(0);
  });

  it("a population with no chains at all says so, and calls it not a zero", () => {
    renderFunnel(funnel({ counted: 0, notMeasured: true }));
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/nothing to measure/i);
    expect(text).toMatch(/not a zero/i);
  });

  it("a genuine 0% is still shown as 0%", () => {
    // The distinction is the whole point: measured-and-never-worked is a
    // finding, and it must not be hidden by the rule that protects
    // never-measured.
    renderFunnel(
      funnel({
        stages: STAGES.map((stage) =>
          tally({ stage, failed: 5, observations: 5 })
        ),
      })
    );
    expect(screen.getAllByText("0%").length).toBe(6);
    expect(screen.getAllByText("(0/5 eligible)").length).toBe(6);
  });
});

describe("rule 3 — exclusions are named, not absorbed", () => {
  it("counts and labels every excluded session", () => {
    renderFunnel(
      funnel({
        total: 12,
        counted: 7,
        exclusions: { absent: 2, deriving: 1, stale: 1, failed: 1 },
      })
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Excluded: 5 sessions");
    expect(text).toContain("2 no chain");
    expect(text).toContain("1 deriving");
    expect(text).toContain("1 awaiting a newer chain");
    expect(text).toContain("1 derivation failed");
  });

  it("says nothing when nothing was excluded", () => {
    renderFunnel(funnel());
    expect(document.body.textContent).not.toContain("Excluded:");
  });

  it("reports observations with no verdict per stage", () => {
    renderFunnel(
      funnel({
        stages: STAGES.map((stage) =>
          tally({
            stage,
            passed: 2,
            notMeasured: 3,
            notApplicable: 1,
            notReached: 1,
            observations: 7,
          })
        ),
      })
    );
    expect(
      screen.getAllByText("5 of 7 observations had no verdict").length
    ).toBe(6);
  });
});

describe("rule 4 — truncation is disclosed", () => {
  it("says so when the population outgrew one scan", () => {
    renderFunnel(funnel({ truncated: true, total: 1000 }));
    expect(document.body.textContent).toMatch(/larger than one scan/i);
  });

  it("stays quiet otherwise", () => {
    renderFunnel(funnel());
    expect(document.body.textContent).not.toMatch(/larger than one scan/i);
  });
});

describe("where the chain stopped", () => {
  it("ranks the stages these sessions stop at", () => {
    renderFunnel(funnel({ firstFailedStage: { call: 2, userValue: 5 } }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Where the chain stopped:");
    // Most common first — that is the one worth looking at.
    expect(text.indexOf("User value (5)")).toBeLessThan(
      text.indexOf("Tool call (2)")
    );
  });

  it("never says root cause", () => {
    renderFunnel(funnel({ firstFailedStage: { call: 2 } }));
    expect((document.body.textContent ?? "").toLowerCase()).not.toContain(
      "root cause"
    );
  });
});

describe("populations stay apart", () => {
  it("records which surface the numbers describe", () => {
    const { container } = renderFunnel(funnel({ source: "swarm" }));
    expect(container.querySelector("[data-source='swarm']")).toBeTruthy();
  });

  it("takes ONE summary — there is no way to hand it two", () => {
    // A `summaries` prop is the shape that would let a caller sum a User
    // Testing scenario into a swarm run. It does not exist, and this
    // assertion is what would notice if it were added.
    const props = Object.keys(
      (StageFunnel as unknown as { propTypes?: object }).propTypes ?? {}
    );
    expect(props).not.toContain("summaries");
    expect(StageFunnel.length).toBe(1);
  });

  it("renders nothing at all without a summary", () => {
    const { container } = render(
      <StageFunnel
        summary={undefined}
        title="User value chain"
        populationLabel="Real User Testing sessions"
      />
    );
    expect(container.innerHTML).toBe("");
  });
});
