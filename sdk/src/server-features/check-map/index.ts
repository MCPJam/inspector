import type { ConformanceCheckRef, ConformanceSuiteKey } from "../types.js";
import type { CheckFeatureTarget } from "./types.js";
import { APPS_CHECK_FEATURES } from "./apps.js";
import { EVENTS_CHECK_FEATURES } from "./events.js";
import { OAUTH_CHECK_FEATURES } from "./oauth.js";
import { PROTOCOL_CHECK_FEATURES } from "./protocol.js";
import { TASKS_CHECK_FEATURES } from "./tasks.js";

export type { CheckFeatureTarget } from "./types.js";

export const CHECK_FEATURE_MAPS: Readonly<
  Record<ConformanceSuiteKey, Readonly<Record<string, CheckFeatureTarget | undefined>>>
> = {
  protocol: PROTOCOL_CHECK_FEATURES,
  apps: APPS_CHECK_FEATURES,
  tasks: TASKS_CHECK_FEATURES,
  events: EVENTS_CHECK_FEATURES,
  oauth: OAUTH_CHECK_FEATURES,
};

export function checkRef(
  suite: ConformanceSuiteKey,
  checkId: string,
): ConformanceCheckRef {
  return `${suite}:${checkId}`;
}

/** Feature ids a check result is evidence for; empty when excluded or unknown. */
export function featuresForCheck(ref: ConformanceCheckRef): readonly string[] {
  const separator = ref.indexOf(":");
  const suite = ref.slice(0, separator) as ConformanceSuiteKey;
  const target = CHECK_FEATURE_MAPS[suite]?.[ref.slice(separator + 1)];
  return Array.isArray(target) ? target : [];
}

/** Inverse map: feature id → check refs that are evidence for it. */
export function checksForFeature(featureId: string): ConformanceCheckRef[] {
  const refs: ConformanceCheckRef[] = [];
  for (const [suite, map] of Object.entries(CHECK_FEATURE_MAPS)) {
    for (const [checkId, target] of Object.entries(map)) {
      if (Array.isArray(target) && target.includes(featureId)) {
        refs.push(checkRef(suite as ConformanceSuiteKey, checkId));
      }
    }
  }
  return refs;
}
