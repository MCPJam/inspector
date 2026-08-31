/**
 * WHICH LAYER an eval trial's failure is attributed to.
 *
 * The provider-error work exists to stop our own model-call failures being
 * filed against the server under test. Both decisions here are the places that
 * work can go wrong in the OTHER direction — attributing to the model a
 * failure that never reached it — which is the same defect wearing a different
 * coat, and just as misleading in a report card whose job is to say whose side
 * broke.
 *
 * Both were found in review after the first version shipped, and both are
 * about a catch site being broader than the comment above it claimed.
 */
import { describe, expect, it } from "vitest";
import { failedLayerForEngineError } from "../drive-hosted-eval-turn.js";
import { modelLayerForErrorSpan } from "../drive-local-eval-turn.js";

describe("the hosted path reads the engine's reported phase", () => {
  it("attributes a stream failure to the model", () => {
    expect(failedLayerForEngineError({ phase: "stream" })).toBe("model");
  });

  it("attributes a PRE-STREAM harness failure to setup, not the model", () => {
    // `runHarnessTurn` wraps its whole turn in one try, so a missing
    // projectId, a missing auth bearer and disabled broker credential delivery
    // all arrive through the same callback a provider outage does. None of
    // them reached a model, and calling them `providerError` would file our
    // own setup bug as the provider's.
    expect(failedLayerForEngineError({ phase: "setup" })).toBe("setup");
  });

  it("still says model when the engine reports no phase at all", () => {
    // The compatibility floor. Every emitter that omits a phase today is a
    // real stream failure, and defaulting the other way would un-attribute
    // the outages this work was built for.
    expect(failedLayerForEngineError({})).toBe("model");
    expect(failedLayerForEngineError(undefined)).toBe("model");
  });
});

describe("the local path reads the error span's own category", () => {
  it("attributes an llm span to the model", () => {
    expect(modelLayerForErrorSpan({ category: "llm" })).toBe("model");
  });

  it.each([["connection"], ["discovery"], ["oauth"], ["step"], ["execution"]])(
    "attributes NOTHING to a %s span",
    (category) => {
      // The branch that finds these selects every non-tool error span. A
      // server we could not connect to is not a provider outage, and saying so
      // would blame the wrong side — the exact failure this work removes.
      expect(modelLayerForErrorSpan({ category })).toBeUndefined();
    },
  );

  it("attributes nothing to a span with no category", () => {
    expect(modelLayerForErrorSpan({})).toBeUndefined();
    expect(modelLayerForErrorSpan(undefined)).toBeUndefined();
  });
});
