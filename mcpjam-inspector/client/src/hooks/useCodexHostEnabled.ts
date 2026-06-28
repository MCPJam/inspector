import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the "Codex" host template running the REAL Codex
 * harness (the `@ai-sdk/harness-codex` adapter) in the New Host template picker
 * (CreateHostDialog). Flag off ⇒ the template is hidden from the grid, so we can
 * iterate on the Codex host profile before exposing it — no deploy needed to
 * flip it on. Mirrors `useClaudeCodeHostEnabled`.
 *
 * Note: an existing config-export "codex" target (no harness) predates this; the
 * flag gates the harness-enabled variant. `useFeatureFlagEnabled` returns
 * `undefined` while flags load — treated as off (`=== true`) so the template
 * never flickers into the picker before PostHog resolves.
 */
export const CODEX_HOST_FEATURE_FLAG = "codex-host-enabled";

export function useCodexHostEnabled(): boolean {
  return useFeatureFlagEnabled(CODEX_HOST_FEATURE_FLAG) === true;
}
