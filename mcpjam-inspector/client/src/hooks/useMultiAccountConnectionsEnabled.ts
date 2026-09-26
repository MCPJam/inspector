import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for connecting more than one OAuth account to the same
 * MCP server. Flag off ⇒ "Connect another account" is hidden, which is the
 * only control that can create a second connection.
 *
 * The SAME key the backend enforces (`lib/featureGates.ts`,
 * `multi-account-connections`), so the advertised surface and the enforced one
 * cannot drift: hiding the button is a courtesy, the server is the gate.
 *
 * Deliberately gates ONLY the add. The accounts list, relabel, set-default and
 * remove stay visible for anyone who already has connections — a de-flagged
 * org must still be able to see and take down what it has.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, treated as off
 * (`=== true`) so the button never flickers in before PostHog resolves.
 */
export const MULTI_ACCOUNT_CONNECTIONS_FEATURE_FLAG =
  "multi-account-connections-enabled";

export function useMultiAccountConnectionsEnabled(): boolean {
  return useFeatureFlagEnabled(MULTI_ACCOUNT_CONNECTIONS_FEATURE_FLAG) === true;
}
