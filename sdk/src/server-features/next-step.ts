/**
 * The next step a "Not checked yet" feature offers. A step is offered only
 * when taking it can produce evidence for that feature on this MCPJam
 * surface; with none, the feature says MCPJam cannot check it yet instead of
 * offering a button that changes nothing.
 */

import { checksForFeature } from "./check-map/index.js";
import { isBackgroundSafeCheck } from "./check-intrusiveness.js";
import { protocolEra } from "./context.js";
import type {
  ConformanceCheckRef,
  ConformanceSuiteKey,
  FeatureDefinition,
  FeatureNextAction,
  ServerFeatureEvidenceInput,
} from "./types.js";

/** The events probe grades these; the Apps probe grades every background-safe Apps check. */
export const EVENTS_PROBE_CHECKS: readonly ConformanceCheckRef[] = [
  "events:events-capability-declared",
  "events:events-list-shape",
];

/** Whether a background probe can grade this check. */
export function isProbeGradedCheck(ref: ConformanceCheckRef): boolean {
  if (!isBackgroundSafeCheck(ref)) return false;
  return ref.startsWith("apps:") || EVENTS_PROBE_CHECKS.includes(ref);
}

/** Whether this surface can run a check that maps to the feature. */
export function hasRunnableCheck(
  featureId: string,
  checksOffered: readonly ConformanceSuiteKey[] | undefined,
): boolean {
  return checksForFeature(featureId).some((ref) => {
    if (!checksOffered) return true;
    const suite = ref.slice(0, ref.indexOf(":")) as ConformanceSuiteKey;
    return checksOffered.includes(suite);
  });
}

export const CANNOT_CHECK_YET = "MCPJam cannot check this yet.";

export interface NextStep {
  reason: string;
  nextAction?: FeatureNextAction;
}

type StepSource = Exclude<
  FeatureDefinition["assessment"]["primary"],
  "configured"
>;

/**
 * The step one evidence source offers, or null when it cannot produce
 * evidence any more: a capture or probe run that already happened and said
 * nothing will say nothing again until the server changes.
 */
function stepFor(
  source: StepSource,
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
): NextStep | null {
  const rules = feature.assessment;
  switch (source) {
    case "declared":
      return rules.declared && !input.declared
        ? {
            reason: "Nothing was captured for this yet. Reconnect to capture it.",
            nextAction: "reconnect",
          }
        : null;
    case "probed": {
      const probeable =
        rules.probed !== undefined ||
        checksForFeature(feature.id).some(isProbeGradedCheck);
      const probesRan = Object.keys(input.probes ?? {}).length > 0;
      return probeable && !probesRan
        ? {
            reason:
              "Background checks have not run for this connection. Refresh to run them.",
            nextAction: "refresh",
          }
        : null;
    }
    case "checked":
      return hasRunnableCheck(feature.id, input.checksOffered)
        ? {
            reason: "Only a conformance run can show this. Run checks to test it.",
            nextAction: "run-checks",
          }
        : null;
    case "observed":
      return rules.observable && observableHere(feature, input)
        ? {
            reason: "Seen only when it is used. Try it in the Playground.",
            nextAction: "use-in-playground",
          }
        : null;
    case "oauth-flow":
      // MCPJam records the summary when an interactive OAuth sign-in to this
      // server completes; reconnecting with saved tokens does not.
      return rules.oauthFlow && !input.oauthFlow
        ? { reason: "Recorded the next time you sign in to this server with OAuth." }
        : null;
  }
}

/** False only when the connection's era is known and is not the one traffic can show. */
function observableHere(
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
): boolean {
  const only = feature.assessment.observableEra;
  if (!only) return true;
  const era = protocolEra(
    input.context?.protocolVersion ?? input.declared?.surface.protocolVersion,
  );
  return era === "unknown" || era === only;
}

const FALLBACK_ORDER: readonly StepSource[] = [
  "checked",
  "probed",
  "declared",
  "observed",
  "oauth-flow",
];

/**
 * The primary source's step when it offers an action, else the first other
 * source that does, else a reason without an action.
 */
export function nextStepFor(
  feature: FeatureDefinition,
  input: ServerFeatureEvidenceInput,
): NextStep {
  const primary = feature.assessment.primary;
  const order: readonly StepSource[] =
    primary === "configured"
      ? FALLBACK_ORDER
      : [primary, ...FALLBACK_ORDER.filter((source) => source !== primary)];
  const steps = order
    .map((source) => stepFor(source, feature, input))
    .filter((step): step is NextStep => step !== null);
  return (
    steps.find((step) => step.nextAction) ?? steps[0] ?? { reason: CANNOT_CHECK_YET }
  );
}
