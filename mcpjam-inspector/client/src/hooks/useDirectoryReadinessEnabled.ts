import { useFeatureFlagEnabled } from "posthog-js/react";

export const DIRECTORY_READINESS_FEATURE_FLAG = "mcpjam-directory-readiness";

/**
 * Directory readiness — the Claude and OpenAI submission grades — is gated.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` both while flags
 * load and when PostHog is unreachable, and both are treated as off. That
 * matters more than for a cosmetic flag, because the hosted half of this
 * surface can spend an organization's MCPJam credits. A flag that defaulted
 * open during a PostHog outage would expose a billed control to every user of
 * a build that was never meant to have it.
 *
 * Mirrors `useSandboxesEnabled`.
 */
export function useDirectoryReadinessEnabled(): boolean {
  return useFeatureFlagEnabled(DIRECTORY_READINESS_FEATURE_FLAG) === true;
}
