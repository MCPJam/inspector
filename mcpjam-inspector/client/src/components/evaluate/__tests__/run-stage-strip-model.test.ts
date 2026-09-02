/**
 * The strip's states, and the zero it must never print.
 *
 * The suite-level funnel this replaces was removed because its most prominent
 * claim was its least reliable: six green stages over a population that
 * excluded the trial that broke. The rules that keep this one honest are that a
 * stage with nothing to divide says so in words, and that a missing document is
 * an absence rather than a row of zeros.
 */
import { describe, expect, it } from "vitest";
import type { EvalStageAnalyticsV1 } from "@mcpjam/sdk/contract";

import { PASS_WORDS } from "./pass-words";
import { buildStageStrip } from "../run-stage-strip-model";
import { GOLDEN_STAGE_ANALYTICS } from "@/test/stage-analytics-fixtures";

function view(document: EvalStageAnalyticsV1 = GOLDEN_STAGE_ANALYTICS) {
  return buildStageStrip({ status: "ready", document });
}

describe("the stage strip", () => {
  it("renders six cells over the run's own population", () => {
    const result = view();
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.cells).toHaveLength(6);
    expect(result.trials).toBeGreaterThan(0);
    for (const cell of result.cells) {
      // Never a bare percentage: the population travels with the number.
      expect(cell.measured).not.toMatch(/%/);
    }
  });

  it("says not measured in words rather than zero", () => {
    const document = structuredClone(GOLDEN_STAGE_ANALYTICS);
    const overall = document.slices.find(
      (slice) => slice.slice.dimension === "overall",
    );
    if (!overall) throw new Error("fixture has no overall slice");
    for (const tally of overall.stages) {
      tally.measured = 0;
      tally.passed = 0;
      tally.failed = 0;
    }

    const result = view(document);
    if (result.kind !== "ready") throw new Error("expected a ready strip");
    for (const cell of result.cells) {
      expect(cell.measured).toBe("not measured");
      expect(cell.tone).toBe("unmeasured");
      // And an unmeasured stage is never dressed as a healthy one.
      expect(cell.measured).not.toMatch(PASS_WORDS);
    }
  });

  it("says a run was not measured rather than vanishing", () => {
    // A run that terminalized before the materializer shipped has no document,
    // and that absence is the honest answer — but said out loud. A section that
    // silently disappeared left a reader unable to tell "not measured" from
    // "this page is broken", which is exactly what it did.
    const result = buildStageStrip({ status: "absent", document: null });
    expect(result.kind).toBe("notMeasured");
    if (result.kind !== "notMeasured") return;
    expect(result.message).toContain("not recorded for this run");
    // Still no zeros: the absence is words, never a funnel.
    expect(result.message).not.toMatch(/\b0\b|0%/);
  });

  it("stays quiet only when nothing was asked for", () => {
    expect(buildStageStrip({ status: "idle", document: null })).toEqual({
      kind: "hidden",
    });
  });

  it("keeps a failed read distinct from an unmeasured run", () => {
    const result = buildStageStrip({
      status: "error",
      document: null,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.message).toContain("could not be read");
  });

  it("says WHICH failure, because they send a reader to different places", () => {
    // One sentence for a permission problem, a deployment without the route, a
    // contract violation and a network blip is how two people ended up looking
    // in the wrong place for the same message.
    const route = buildStageStrip({
      status: "error",
      document: null,
      error: { kind: "routeUnavailable", status: 501 },
    });
    if (route.kind !== "unavailable") throw new Error("expected unavailable");
    expect(route.message).toContain("does not serve stage measurements");
    expect(route.message).toContain("HTTP 501");

    const contract = buildStageStrip({
      status: "error",
      document: null,
      error: { kind: "invalidContract" },
    });
    if (contract.kind !== "unavailable") throw new Error("expected unavailable");
    expect(contract.message).toContain("did not match the published contract");
    // No status was recorded, so none is invented.
    expect(contract.message).not.toContain("HTTP");

    const denied = buildStageStrip({
      status: "error",
      document: null,
      error: { kind: "requestFailed", status: 401 },
    });
    if (denied.kind !== "unavailable") throw new Error("expected unavailable");
    expect(denied.message).toContain("HTTP 401");
  });

  it("says out loud when a judge fanout could still move the numbers", () => {
    const provisional = structuredClone(GOLDEN_STAGE_ANALYTICS);
    provisional.materializationState = "provisional";
    const result = view(provisional);
    if (result.kind !== "ready") throw new Error("expected a ready strip");
    expect(result.provisional).toBe(true);
  });

  it("marks a stage with measured failures for attention", () => {
    const document = structuredClone(GOLDEN_STAGE_ANALYTICS);
    const overall = document.slices.find(
      (slice) => slice.slice.dimension === "overall",
    );
    if (!overall) throw new Error("fixture has no overall slice");
    const target = overall.stages[2];
    target.measured = 3;
    target.passed = 2;
    target.failed = 1;

    const result = view(document);
    if (result.kind !== "ready") throw new Error("expected a ready strip");
    const cell = result.cells.find((entry) => entry.stage === target.stage);
    expect(cell?.tone).toBe("attention");
    expect(cell?.measured).toBe("2 of 3 measured");
  });
});
