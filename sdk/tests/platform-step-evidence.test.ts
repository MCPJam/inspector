import { describe, expect, it } from "vitest";
import {
  collectStepScreenshots,
  selectStepScreenshots,
} from "../src/platform/step-evidence.js";
import type { PlatformEvalStepResult } from "../src/platform/types.js";

function step(
  overrides: Partial<PlatformEvalStepResult> & { stepIndex: number }
): PlatformEvalStepResult {
  return {
    stepId: `s${overrides.stepIndex}`,
    kind: "interact",
    status: "ok",
    reason: null,
    ...overrides,
  } as PlatformEvalStepResult;
}

describe("collectStepScreenshots", () => {
  it("returns nothing when no step produced a screenshot", () => {
    expect(
      collectStepScreenshots([step({ stepIndex: 0 }), step({ stepIndex: 1 })])
    ).toEqual([]);
  });

  it("takes the platform's RESOLVED url, with the context for a caption", () => {
    // The platform resolves `screenshotUrl` for us, so a consumer never has to
    // know how to sign a storage key.
    const found = collectStepScreenshots([
      step({
        stepIndex: 2,
        stepId: "click",
        evidence: { screenshotUrl: "https://cdn/2.png", locatorLabel: "Submit" },
      }),
    ]);
    expect(found).toEqual([
      {
        url: "https://cdn/2.png",
        stepId: "click",
        stepIndex: 2,
        status: "ok",
        label: "Submit",
      },
    ]);
  });

  it("orders by the steps' own index, not by arrival", () => {
    // The list is the story of what the run did; out-of-order pictures tell it
    // wrong.
    const found = collectStepScreenshots([
      step({ stepIndex: 3, evidence: { screenshotUrl: "https://cdn/3.png" } }),
      step({ stepIndex: 1, evidence: { screenshotUrl: "https://cdn/1.png" } }),
      step({ stepIndex: 2, evidence: { screenshotUrl: "https://cdn/2.png" } }),
    ]);
    expect(found.map((entry) => entry.url)).toEqual([
      "https://cdn/1.png",
      "https://cdn/2.png",
      "https://cdn/3.png",
    ]);
  });

  it("drops a url repeated across steps", () => {
    // A video-backed run can repeat one frame url, and the same picture twice
    // reads as two things having happened.
    const found = collectStepScreenshots([
      step({ stepIndex: 0, evidence: { screenshotUrl: "https://cdn/same.png" } }),
      step({ stepIndex: 1, evidence: { screenshotUrl: "https://cdn/same.png" } }),
    ]);
    expect(found).toHaveLength(1);
  });

  it("stops at the limit rather than making the caller slice", () => {
    const steps = Array.from({ length: 20 }, (_, index) =>
      step({
        stepIndex: index,
        evidence: { screenshotUrl: `https://cdn/${index}.png` },
      })
    );
    expect(collectStepScreenshots(steps, { limit: 3 })).toHaveLength(3);
  });

  it("can restrict to the steps that FAILED", () => {
    const steps = [
      step({ stepIndex: 0, evidence: { screenshotUrl: "https://cdn/0.png" } }),
      step({
        stepIndex: 1,
        status: "fail",
        evidence: { screenshotUrl: "https://cdn/1.png" },
      }),
    ];
    expect(
      collectStepScreenshots(steps, { failedOnly: true }).map((e) => e.url)
    ).toEqual(["https://cdn/1.png"]);
  });

  it("ignores a non-string or empty screenshot url", () => {
    const steps = [
      step({ stepIndex: 0, evidence: { screenshotUrl: "" } }),
      step({
        stepIndex: 1,
        evidence: { screenshotUrl: 42 as unknown as string },
      }),
    ];
    expect(collectStepScreenshots(steps)).toEqual([]);
  });
});

describe("selectStepScreenshots", () => {
  it("prefers the failing steps — they ARE the answer", () => {
    const steps = [
      step({ stepIndex: 0, evidence: { screenshotUrl: "https://cdn/ok.png" } }),
      step({
        stepIndex: 1,
        status: "fail",
        evidence: { screenshotUrl: "https://cdn/bad.png" },
      }),
    ];
    expect(selectStepScreenshots(steps, 5).map((e) => e.url)).toEqual([
      "https://cdn/bad.png",
    ]);
  });

  it("still shows a healthy run's steps rather than reporting no evidence", () => {
    // Falling back matters: otherwise a caller has to special-case a passing
    // run to avoid saying it produced nothing.
    const steps = [
      step({ stepIndex: 0, evidence: { screenshotUrl: "https://cdn/a.png" } }),
      step({ stepIndex: 1, evidence: { screenshotUrl: "https://cdn/b.png" } }),
    ];
    expect(selectStepScreenshots(steps, 5)).toHaveLength(2);
  });

  it("honours the limit on both branches", () => {
    const failing = Array.from({ length: 9 }, (_, index) =>
      step({
        stepIndex: index,
        status: "fail",
        evidence: { screenshotUrl: `https://cdn/f${index}.png` },
      })
    );
    expect(selectStepScreenshots(failing, 2)).toHaveLength(2);
    const passing = failing.map((entry) => ({
      ...entry,
      status: "ok" as const,
    }));
    expect(selectStepScreenshots(passing, 2)).toHaveLength(2);
  });
});
