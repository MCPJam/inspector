import { describe, expect, it } from "vitest";
import {
  getXAAPhaseNumber,
  XAA_PHASE_ORDER,
  XAA_PHASES,
  XAA_STEP_METADATA,
  XAA_STEP_ORDER,
} from "../step-metadata";

// The phase layer maps the debugger's machine steps onto the four numbered
// steps of draft-ietf-oauth-identity-assertion-authz-grant plus a Phase 0
// for MCP discovery. These invariants keep the teaching structure honest.

describe("XAA phase metadata", () => {
  it("assigns every step except idle to a phase", () => {
    for (const step of XAA_STEP_ORDER) {
      const { phase } = XAA_STEP_METADATA[step];
      if (step === "idle") {
        expect(phase).toBeUndefined();
      } else {
        expect(phase, `step ${step} must belong to a phase`).toBeDefined();
        expect(XAA_PHASE_ORDER).toContain(phase);
      }
    }
  });

  it("orders steps so phases never interleave or run backwards", () => {
    const phaseIndexes = XAA_STEP_ORDER.filter((s) => s !== "idle").map(
      (step) => getXAAPhaseNumber(XAA_STEP_METADATA[step].phase!)
    );
    const sorted = [...phaseIndexes].sort((a, b) => a - b);
    expect(phaseIndexes).toEqual(sorted);
  });

  it("numbers phases 0-4 with bootstrap as the only non-spec phase", () => {
    expect(getXAAPhaseNumber("bootstrap")).toBe(0);
    expect(XAA_PHASES.bootstrap.specStep).toBeNull();
    // Phases 1-4 carry the draft's step numbers in order.
    const specSteps = XAA_PHASE_ORDER.filter((p) => p !== "bootstrap").map(
      (p) => XAA_PHASES[p].specStep
    );
    expect(specSteps).toEqual([1, 2, 3, 4]);
  });

  it("matches phase numbers to spec step numbers for the grant phases", () => {
    for (const phase of XAA_PHASE_ORDER) {
      const { specStep } = XAA_PHASES[phase];
      if (specStep !== null) {
        expect(getXAAPhaseNumber(phase)).toBe(specStep);
      }
    }
  });

  it("expands the ID-JAG acronym on the received_id_jag step", () => {
    const moments = XAA_STEP_METADATA.received_id_jag.teachableMoments ?? [];
    expect(
      moments.some((m) =>
        m.includes("Identity Assertion JWT Authorization Grant")
      )
    ).toBe(true);
  });
});
