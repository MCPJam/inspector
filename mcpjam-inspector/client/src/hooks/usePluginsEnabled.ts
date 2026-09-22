import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the OpenAI plugin import surface (Connect
 * "Add plugin" UI, plugin cards, attachment selectors, and the plugin
 * import/query API hooks). Flag off ⇒ every plugin surface stays hidden and
 * the client plugin API refuses to start imports, so rollout is per-user /
 * percentage-based without a deploy.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` while flags load
 * AND when the flag does not exist. Both are treated as "not enabled"
 * (`=== true`), so plugin surfaces stay hidden until the flag is deliberately
 * created and flipped on. Unlike `skills-enabled` (hosted-only), this gates
 * BOTH hosted and local clients until GA — plugin import is a new surface,
 * not an existing local behavior (see the plan's "PostHog implementation").
 *
 * The backend import/commit APIs are NOT flag-gated; project-admin
 * authorization is the security boundary. The flag is a visibility/rollout
 * control only.
 */
export const PLUGINS_FEATURE_FLAG = "plugins-enabled";

/**
 * Tri-state flag: `true` enabled, `false` explicitly disabled, `undefined`
 * while PostHog is still loading (or the flag is absent). Route guards must
 * distinguish "disabled" from "not resolved yet" so a direct cold load of a
 * plugin URL does not redirect a flagged-in user before PostHog hydrates
 * (mirrors `useSkillsEnabledState`). Visibility gates that only hide UI
 * should use `usePluginsEnabled` instead.
 */
export function usePluginsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(PLUGINS_FEATURE_FLAG);
}

export function usePluginsEnabled(): boolean {
  return usePluginsEnabledState() === true;
}
