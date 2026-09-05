import { describe, expect, it } from "vitest";

import {
  descriptionExperimentHeader,
  evidenceCaveat,
  frozenDifferencesLabel,
  frozenFieldsLabel,
  intervalBoundPhrase,
  isEmulatedDescriptionExperimentEngine,
} from "../description-experiment-model";
import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";

describe("isEmulatedDescriptionExperimentEngine", () => {
  it("accepts only a recorded emulated engine", () => {
    expect(isEmulatedDescriptionExperimentEngine("emulated")).toBe(true);
  });

  it("refuses an unrecorded engine — unknown is not emulated", () => {
    expect(isEmulatedDescriptionExperimentEngine(undefined)).toBe(false);
    expect(isEmulatedDescriptionExperimentEngine("")).toBe(false);
  });

  it("refuses harness engines and mixed", () => {
    expect(isEmulatedDescriptionExperimentEngine("harness:claude-code")).toBe(
      false,
    );
    expect(isEmulatedDescriptionExperimentEngine("harness:cursor")).toBe(false);
    expect(isEmulatedDescriptionExperimentEngine("harness:codex")).toBe(false);
    expect(isEmulatedDescriptionExperimentEngine("mixed")).toBe(false);
    expect(isEmulatedDescriptionExperimentEngine("claude-code")).toBe(false);
  });
});

describe("intervalBoundPhrase", () => {
  it("never names a number when the interval is null", () => {
    const phrase = intervalBoundPhrase({
      verdict: "insufficient_data",
      interval: null,
    });
    expect(phrase).toBe("not enough trials to say");
    expect(phrase).not.toMatch(/\d/);
  });

  it("uses the lower bound when the rewrite improved", () => {
    expect(
      intervalBoundPhrase({
        verdict: "improved",
        interval: { deltaPoints: 50, lowerPoints: 12.4, upperPoints: 72 },
      }),
    ).toBe("at least +12 points");
  });

  it("uses the upper bound when the rewrite regressed", () => {
    expect(
      intervalBoundPhrase({
        verdict: "regressed",
        interval: { deltaPoints: -50, lowerPoints: -72, upperPoints: -12.2 },
      }),
    ).toBe("at most -12 points");
  });

  it("claims no direction on no_difference even when the delta leans", () => {
    // A positive point estimate whose interval straddles zero: the report
    // says no difference, so the phrase must not say "at least".
    const phrase = intervalBoundPhrase({
      verdict: "no_difference",
      interval: { deltaPoints: 10, lowerPoints: -5, upperPoints: 25 },
    });
    expect(phrase).toBe("no difference at this sample size");
    expect(phrase).not.toMatch(/at least|at most/);
  });
});

describe("frozen arms", () => {
  it("names what differed, in the report's order", () => {
    expect(
      frozenDifferencesLabel({
        equal: false,
        differences: ["hostConfigId", "toolSnapshotHash"],
      }),
    ).toBe("arms differ: hostConfigId, toolSnapshotHash");
    expect(frozenDifferencesLabel({ equal: true })).toBeNull();
  });

  it("explains a reproducible label by the report's own differences", () => {
    const caveat = evidenceCaveat("reproducible", {
      equal: false,
      differences: ["toolSnapshotHash"],
    });
    expect(caveat).toContain("they differed on toolSnapshotHash");
    expect(caveat).toContain("upstream server's state was not verified");
  });

  it("calls frozen only the fields the report recorded", () => {
    expect(
      frozenFieldsLabel({
        equal: true,
        model: ["claude"],
        engine: "emulated",
      }),
    ).toBe(" with frozen model and engine; host and catalog not recorded");
    expect(
      frozenFieldsLabel({
        equal: true,
        model: ["claude"],
        engine: "emulated",
        hostConfigId: "host_1",
        toolSnapshotHash: "snap_1",
      }),
    ).toBe(" with frozen model, engine, host, and catalog");
    expect(frozenFieldsLabel({ equal: true, model: [] })).toBe(
      "; model, engine, host, and catalog not recorded",
    );
  });

  it("does not claim a frozen field the report left out", () => {
    const partial = evidenceCaveat("reproducible", {
      equal: true,
      model: ["claude"],
      engine: "emulated",
    });
    expect(partial).toContain("with frozen model and engine");
    expect(partial).toContain("host and catalog not recorded");
    expect(partial).not.toContain("frozen model, engine, host, and catalog");
    expect(evidenceCaveat("reproducible", { equal: true })).toContain(
      "model, engine, host, and catalog not recorded",
    );
    expect(evidenceCaveat("reproducible")).toContain(
      "model, engine, host, and catalog not recorded",
    );
  });
});

describe("descriptionExperimentHeader", () => {
  it("does not invent a rate while proposing", () => {
    const experiment = {
      id: "e",
      suiteId: "s",
      sourceRunId: "r",
      toolName: "get_user",
      status: "proposing",
    } as EvalDescriptionExperiment;
    expect(descriptionExperimentHeader(experiment)).toBe(
      "Description experiment · `get_user` · drafting a rewrite",
    );
  });
});
