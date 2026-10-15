import { HOSTED_MODE } from "@/lib/config";
import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the "Codex" host template running the REAL Codex
 * harness in the New Host template picker (CreateHostDialog). Flag off ⇒ the
 * template is hidden from the grid, so we can iterate on the Codex host
 * profile before exposing it — no deploy needed to flip it on. Mirrors
 * `useClaudeCodeHostEnabled`, including the local arm: on a local Inspector,
 * local Codex being enabled for this account also unlocks the template, since
 * that is what lets a member add a Codex client that runs on this machine.
 *
 * Note: an existing config-export "codex" target (no harness) predates this; the
 * flag gates the harness-enabled variant. `useFeatureFlagEnabled` returns
 * `undefined` while flags load — treated as off (`=== true`) so the template
 * never flickers into the picker before PostHog resolves.
 */
export const CODEX_HOST_FEATURE_FLAG = "codex-host-enabled";

/** The local arm's flag, evaluated server-side for the verified member. */
export const LOCAL_CODEX_FEATURE_FLAG = "local-codex-enabled";

/** Tri-state flag value for route guards that must wait for PostHog. */
export function useCodexHostEnabledState(): boolean | undefined {
  const hosted = useFeatureFlagEnabled(CODEX_HOST_FEATURE_FLAG);
  const local = useFeatureFlagEnabled(LOCAL_CODEX_FEATURE_FLAG);
  if (HOSTED_MODE) return hosted;
  if (hosted === true || local === true) return true;
  return hosted === undefined || local === undefined ? undefined : false;
}

export function useCodexHostEnabled(): boolean {
  return useCodexHostEnabledState() === true;
}
