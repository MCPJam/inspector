import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for ALL Project Computers UI (the host-editor computer
 * toggle, the Computer nav tab, and the Computer view/terminal). Flag off ⇒
 * the feature is invisible, so we can roll it out per-user / by percentage
 * without a deploy. This is the visibility gate; a deployment still needs the
 * backend computer config (E2B creds + the data-plane secrets) for the
 * feature to actually function once a user is flagged in.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (`=== true`) so the UI never flickers the feature on before PostHog
 * resolves.
 */
export const COMPUTERS_FEATURE_FLAG = "computers-enabled";

/**
 * Tri-state flag: `true` enabled, `false` explicitly disabled, `undefined`
 * while PostHog is still loading. Route guards must distinguish "disabled"
 * from "not resolved yet" so a direct /computer cold load doesn't redirect a
 * flagged-in user before the flag hydrates (see `ComputerRoute`). Visibility
 * gates that only hide UI should use `useComputersEnabled` instead.
 */
export function useComputersEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(COMPUTERS_FEATURE_FLAG);
}

export function useComputersEnabled(): boolean {
  return useComputersEnabledState() === true;
}

/**
 * Dark-launch gate for the LOCAL computer engine ("This machine")
 * specifically — a second, narrower flag inside the `computers-enabled`
 * surface. It gates local-engine CANDIDACY in `useComputerEngine` (which
 * hides the Computer tab's Local⇄Cloud toggle and local face, the playground
 * rail's local shell body, the consent gate, and the local chat
 * transmission in one place) plus the bash run-location pill. Flag off ⇒ a
 * local inspector looks and behaves exactly as before the local engine
 * shipped. The server keeps the capability (`MCPJAM_LOCAL_COMPUTER_ENABLED`
 * remains the emergency stop), so flagging a user in needs no env var and
 * launching needs no release — just the PostHog rollout.
 *
 * `undefined` while flags load ⇒ off (`=== true`): fail-closed, same as
 * `useComputersEnabled`.
 */
export const LOCAL_COMPUTER_FEATURE_FLAG = "local-computer-enabled";

export function useLocalComputerEnabled(): boolean {
  return useFeatureFlagEnabled(LOCAL_COMPUTER_FEATURE_FLAG) === true;
}

/**
 * Dark-launch gate for the LOCAL HARNESS target ("Native on this machine") —
 * running the real Claude Code agent as a supervised process on the user's own
 * hardware rather than in an E2B computer.
 *
 * A separate flag from `local-computer-enabled`, not a reuse of it, because
 * they gate different capabilities with different blast radii: that one lets
 * the user's machine run BASH COMMANDS the model asks for, this one lets it run
 * a whole vendor agent with its own tool loop. A deployment should be able to
 * have either without the other.
 *
 * Gates every UI surface: the target selector, the consent sheet, the runtime
 * installer, and the "ran natively" attribution. The server keeps its own
 * capability — `MCPJAM_LOCAL_HARNESS_ENABLED` is the emergency stop — so
 * flagging a user in needs no env var and launching needs no release.
 *
 * `undefined` while flags load ⇒ off (`=== true`): fail-closed, so the UI never
 * flickers the feature on before PostHog resolves.
 */
export const LOCAL_HARNESS_FEATURE_FLAG = "local-harness-enabled";

export function useLocalHarnessEnabled(): boolean {
  return useFeatureFlagEnabled(LOCAL_HARNESS_FEATURE_FLAG) === true;
}
