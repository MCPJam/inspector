import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the "Cursor CLI" host template running the REAL
 * Cursor harness (the `@ai-sdk/harness-cursor` adapter over ACP) in the New
 * Host template picker (CreateHostDialog). Flag off ⇒ the template is hidden
 * from the grid, so the host profile can be iterated on before it is exposed —
 * no deploy needed to flip it on. Mirrors `useCodexHostEnabled`.
 *
 * Note: the pre-existing EMULATED `cursor` template (the IDE chat-panel mirror)
 * is a different host and is NOT gated by this — it stays visible exactly as
 * before. This flag governs `cursor-cli` only.
 *
 * The backend enforces the same key server-side (`cursor-harness` in
 * `lib/featureGates.ts`), so hiding the template and refusing the write are one
 * lever rather than two that can drift.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as off
 * (`=== true`) so the template never flickers into the picker before PostHog
 * resolves.
 */
export const CURSOR_HOST_FEATURE_FLAG = "cursor-host-enabled";

/** Tri-state flag value for route guards that must wait for PostHog. */
export function useCursorHostEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(CURSOR_HOST_FEATURE_FLAG);
}

export function useCursorHostEnabled(): boolean {
  return useCursorHostEnabledState() === true;
}
