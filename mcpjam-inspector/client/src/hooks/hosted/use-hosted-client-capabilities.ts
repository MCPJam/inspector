import { useMemo } from "react";
import { getDefaultClientCapabilities } from "@mcpjam/sdk/browser";
import { getEffectiveProjectClientCapabilities } from "@/lib/client-config";

/**
 * Resolve the client capabilities for the hosted API context, with a stable
 * identity.
 *
 * The stability is the whole point, not an optimization. This value feeds
 * `useApiContext`'s dependency array, whose layout effect tears the global API
 * context down and rebuilds it on every dependency change — two
 * `notifyApiContextChanged()` bumps per run. `useAggregatedTools` subscribes to
 * that revision and refetches when it changes, and its own `setState` calls
 * then trigger the next render. A fresh reference here therefore closes a
 * feedback loop that issues `/api/web/tools/list` as fast as React can render.
 *
 * That loop is not hypothetical. On 2026-08-06 a single user produced 3,705
 * failed requests in one hour — two bursts of ~1,300 in under 30 seconds each,
 * roughly 43 requests/second against one server — and nothing alerted.
 *
 * It only manifests on failure, which is what made it easy to miss: when a
 * server connects, `activeHost.clientCapabilities` is defined and the `??`
 * chain short-circuits on a stable object. When a server fails to authenticate
 * the host never hydrates capabilities, so resolution falls through to
 * `getEffectiveProjectClientCapabilities` / `getDefaultClientCapabilities`,
 * both of which mint a new object every call — and the loop runs unbounded.
 */
export function useHostedClientCapabilities(
  hostClientCapabilities: unknown,
  projectClientConfig: Parameters<
    typeof getEffectiveProjectClientCapabilities
  >[0],
): Record<string, unknown> {
  return useMemo(
    () =>
      (hostClientCapabilities ??
        getEffectiveProjectClientCapabilities(projectClientConfig) ??
        getDefaultClientCapabilities()) as Record<string, unknown>,
    // Deliberately keyed on the two INPUTS rather than the resolved value:
    // the resolved value is what churns, so depending on it would defeat the
    // memo entirely.
    [hostClientCapabilities, projectClientConfig],
  );
}
