import { describe, expect, it } from "vitest";
import {
  SERVER_FEATURE_CATALOG,
  checksForFeature,
  hasRunnableCheck,
  isProbeGradedCheck,
  type FeatureDefinition,
} from "@mcpjam/sdk/browser";
import { CANVAS_CHECK_SUITES, CANVAS_SETUP_OFFERED } from "../setup-state";

/**
 * A feature's "how to" copy may only send the reader to a step that can
 * produce evidence for that feature on this page. Each rule names the step
 * the copy promises and what has to be true for the step to show anything.
 */
const PROMISES: ReadonlyArray<{
  step: string;
  says: RegExp;
  reachable: (feature: FeatureDefinition) => boolean;
}> = [
  {
    step: "Playground",
    says: /\bPlayground\b/,
    reachable: (feature) => feature.assessment.observable === true,
  },
  {
    step: "Run checks",
    says: /\bRun (the [\w ]+ )?checks\b|\bconformance run\b/i,
    reachable: (feature) => hasRunnableCheck(feature.id, CANVAS_CHECK_SUITES),
  },
  {
    step: "Refresh",
    says: /\bRefresh\b/,
    reachable: (feature) =>
      feature.assessment.probed !== undefined ||
      checksForFeature(feature.id).some(isProbeGradedCheck),
  },
  {
    step: "Set up in MCPJam",
    says: /\bset (it )?up\b[^.]*\bin MCPJam\b/i,
    reachable: (feature) =>
      feature.assessment.setup !== undefined &&
      CANVAS_SETUP_OFFERED.includes(feature.assessment.setup),
  },
];

/** A parent's copy speaks for its children, so a child's step counts. */
function withDescendants(feature: FeatureDefinition): FeatureDefinition[] {
  const children = SERVER_FEATURE_CATALOG.filter((f) => f.parent === feature.id);
  return [feature, ...children.flatMap(withDescendants)];
}

describe("server canvas copy", () => {
  it("only promises steps the page can take for that feature", () => {
    const broken: string[] = [];
    for (const feature of SERVER_FEATURE_CATALOG) {
      const copy = `${feature.summary} ${feature.howTo ?? ""}`;
      for (const promise of PROMISES) {
        if (
          promise.says.test(copy) &&
          !withDescendants(feature).some(promise.reachable)
        ) {
          broken.push(`${feature.id}: promises ${promise.step}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
