import { describe, expect, it } from "vitest";
import {
  buildRefinementVerificationPlan,
  FALLBACK_VERIFICATION_MODELS,
} from "../refinement-verification-plan";

describe("buildRefinementVerificationPlan", () => {
  it("returns four steps with stable labels", () => {
    const steps = buildRefinementVerificationPlan({
      session: {
        candidateParaphraseQuery: "paraphrase version",
        candidateSnapshot: {
          query: "main query",
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      },
      representativeIteration: {
        testCaseSnapshot: {
          model: "openai/gpt-5-mini",
          provider: "openai",
        },
      },
      suiteModels: [],
    });

    expect(steps.map((s) => s.label)).toEqual([
      "same-model-1",
      "same-model-2",
      "paraphrase",
      "cross-model",
    ]);
    expect(steps[0].model).toBe("openai/gpt-5-mini");
    expect(steps[2].query).toBe("paraphrase version");
  });

  it("returns empty array when session missing candidate", () => {
    expect(
      buildRefinementVerificationPlan({
        session: { candidateSnapshot: null },
        representativeIteration: null,
        suiteModels: [],
      }),
    ).toEqual([]);
  });

  it("uses fallback models when no suite models", () => {
    const steps = buildRefinementVerificationPlan({
      session: {
        candidateSnapshot: {
          query: "q",
          models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
        },
      },
      representativeIteration: null,
      suiteModels: [],
    });
    const cross = steps.find((s) => s.label === "cross-model");
    expect(cross).toBeTruthy();
    expect(cross!.model).toBe(FALLBACK_VERIFICATION_MODELS[1].model);
  });
});
