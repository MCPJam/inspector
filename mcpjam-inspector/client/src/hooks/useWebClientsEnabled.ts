import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * The one rollout gate for Claude web and ChatGPT web: the clients, their
 * accounts, the pane and the suite choices. The backend refuses the runtimes
 * and account writes on the same key, so hiding and refusing are one lever.
 *
 * The same key as `WEB_CLIENTS_FEATURE_FLAG` in `shared/web-clients.ts`,
 * written out because the flag allowlist ratchet reads keys from client
 * sources only. `undefined` while flags load, which reads as off.
 */
export const WEB_CLIENTS_FLAG = "web-clients-enabled";

/** Tri-state flag value for route guards that must wait for PostHog. */
export function useWebClientsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(WEB_CLIENTS_FLAG);
}

export function useWebClientsEnabled(): boolean {
  return useWebClientsEnabledState() === true;
}
