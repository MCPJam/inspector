import { useFeatureFlagEnabled } from "posthog-js/react";

export const INTEGRATIONS_TAB_FEATURE_FLAG = "integrations-tab";

/**
 * Whether the Integrations settings tab exists for this reader — the rail
 * entry, its search results, and the page itself.
 *
 * This is a BETA GATE ON THE WHOLE TAB, one level above the per-card flags.
 * Each card inside already decides for itself whether to render (GitHub Checks
 * asks the server, Discord and Observability read their own flags), so a
 * flagged-in reader sees the same page they see today; a flagged-out one never
 * reaches it, even by typing the URL.
 *
 * There is no server-side twin, because there is nothing to enforce: the tab is
 * a container, and every write behind it is already governed by its own
 * feature's authority. Hiding the container is a presentation decision, so it
 * is decided in one place, on the client.
 *
 * ── Why there are two hooks ─────────────────────────────────────────────────
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, and the two
 * callers owe that window opposite answers:
 *
 *   - LISTING the tab is reversible, so `undefined` reads as OFF. An entry
 *     that appears and then vanishes is worse than one that arrives late.
 *   - REDIRECTING is not reversible. Treating `undefined` as OFF there throws
 *     a flagged-IN reader off their own page before the flag has spoken —
 *     every direct hit on `/settings/integrations` lands mid-load, so that is
 *     the ordinary path, not an edge case.
 */
export function useIntegrationsTabEnabled(): boolean {
  return useIntegrationsTabFlag() === true;
}

/**
 * The same flag, with its LOADING state intact: `undefined` until PostHog has
 * answered. For callers that must wait rather than guess — see above.
 */
export function useIntegrationsTabFlag(): boolean | undefined {
  return useFeatureFlagEnabled(INTEGRATIONS_TAB_FEATURE_FLAG);
}
