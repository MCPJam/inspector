import { describe, expect, it } from "vitest";
import {
  FRICTION_SIGNALS_VERSION,
  type EvalTrialFrictionSignals,
} from "@mcpjam/sdk/contract";
import { toFrictionSignalsProjection } from "../eval-friction-projection.js";

const measured: EvalTrialFrictionSignals = {
  version: FRICTION_SIGNALS_VERSION,
  state: "measured",
  callCount: 3,
  resultAvailableCount: 3,
  timedCallCount: 0,
  identifierSignals: { state: "measured" },
  signals: [
    {
      kind: "identifierSurfacedUnused",
      informationCallIndex: 0,
      observedAtCallIndex: 2,
      toolName: "search_issues",
      identifierKeyPaths: ["results[].id"],
      identifierCount: 2,
      laterCallCount: 2,
    },
  ],
};

describe("toFrictionSignalsProjection", () => {
  it("projects a validated document and drops everything else on the record", () => {
    expect(
      toFrictionSignalsProjection({
        frictionSignals: measured,
        stageResults: [],
        internalOnly: "drop me",
      }),
    ).toEqual({ frictionSignals: measured });
  });

  it("quarantines a document that does not validate", () => {
    expect(
      toFrictionSignalsProjection({
        frictionSignals: { version: 1, state: "measured" },
      }),
    ).toEqual({ frictionSignalsUnverified: true });
    // A client-shaped forgery: the identifier half says it never looked, and
    // an identifier signal is present anyway.
    expect(
      toFrictionSignalsProjection({
        frictionSignals: {
          ...measured,
          identifierSignals: {
            state: "notMeasured",
            reason: "resultsUnavailable",
          },
        },
      }),
    ).toEqual({ frictionSignalsUnverified: true });
  });

  it("omits the block entirely for metadata that predates the measurement", () => {
    expect(toFrictionSignalsProjection({ stageResults: [] })).toEqual({});
    expect(toFrictionSignalsProjection(undefined)).toEqual({});
    expect(toFrictionSignalsProjection(null)).toEqual({});
  });

  it("never carries an identifier value across the boundary", () => {
    const projected = toFrictionSignalsProjection({
      frictionSignals: measured,
    });
    expect(JSON.stringify(projected)).toContain("results[].id");
    expect(JSON.stringify(projected)).not.toContain("ISSUE-");
  });
});
