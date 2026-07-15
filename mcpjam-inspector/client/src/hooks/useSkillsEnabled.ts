import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for hosted Cloud Skills (the Skills nav tab + route and
 * the Playground `/` skill picker). Flag off ⇒ hosted skills are invisible and
 * the Playground never lists/loads cloud skills, so we can QA + roll them out
 * per-user / by percentage without a deploy.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` while flags load AND
 * when the flag does not exist. Both are treated as "not enabled" (`=== true`),
 * so hosted skills stay hidden until the flag is deliberately created and
 * flipped on. This gates hosted mode only; local-mode filesystem skills are
 * unaffected (their call sites never read this flag).
 */
export const SKILLS_FEATURE_FLAG = "skills-enabled";

/**
 * Tri-state flag: `true` enabled, `false` explicitly disabled, `undefined`
 * while PostHog is still loading (or the flag is absent). Route guards must
 * distinguish "disabled" from "not resolved yet" so a direct /skills cold load
 * doesn't redirect a flagged-in user before the flag hydrates (see
 * `SkillsRoute`). Visibility gates that only hide UI should use
 * `useSkillsEnabled` instead.
 */
export function useSkillsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(SKILLS_FEATURE_FLAG);
}

export function useSkillsEnabled(): boolean {
  return useSkillsEnabledState() === true;
}
