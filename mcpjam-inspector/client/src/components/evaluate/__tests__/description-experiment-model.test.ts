import { describe, expect, it } from "vitest";

import {
  descriptionExperimentHeader,
  intervalBoundPhrase,
  isEmulatedDescriptionExperimentEngine,
} from "../description-experiment-model";
import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";

describe("isEmulatedDescriptionExperimentEngine", () => {
  it("treats emulated and unrecorded as supported", () => {
    expect(isEmulatedDescriptionExperimentEngine(undefined)).toBe(true);
    expect(isEmulatedDescriptionExperimentEngine("emulated")).toBe(true);
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
    expect(intervalBoundPhrase(null)).toBe("not enough trials to say");
    expect(intervalBoundPhrase(null)).not.toMatch(/\d/);
  });

  it("uses the lower bound when the rewrite improved", () => {
    expect(
      intervalBoundPhrase({
        deltaPoints: 50,
        lowerPoints: 12.4,
        upperPoints: 72,
      }),
    ).toBe("at least +12 points");
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
