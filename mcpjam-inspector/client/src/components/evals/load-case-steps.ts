import {
  normalizeSteps,
  promptTurnsToSteps,
  resolvePromptTurnsWithLegacyProbe,
  type TestStep,
} from "@/shared/steps";

/**
 * Seed the editor's `editForm.steps` from a test case. The backend stores
 * `steps` natively; prefer them directly. Old `widget_probe`/pre-steps blobs
 * (no `steps`) are bridged once through the legacy resolver — the ONE remaining
 * use of the prompt-turns adapter on the load path, deletable in Phase E once
 * no un-migrated rows remain.
 */
export function loadCaseSteps(testCase: unknown): TestStep[] {
  const steps = (testCase as { steps?: unknown })?.steps;
  if (Array.isArray(steps) && steps.length > 0) {
    return normalizeSteps(steps);
  }
  return promptTurnsToSteps(
    resolvePromptTurnsWithLegacyProbe(
      testCase as Parameters<typeof resolvePromptTurnsWithLegacyProbe>[0],
    ),
  );
}
