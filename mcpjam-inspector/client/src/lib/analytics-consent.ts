import { useSyncExternalStore } from "react";

declare global {
  interface Window {
    __MCPJAM_ANALYTICS_CONSENT_REQUIRED__?: boolean;
  }
}

export type AnalyticsConsent = "granted" | "denied";

/** The parts of a posthog-js instance a consent choice drives. */
export interface AnalyticsConsentClient {
  opt_in_capturing: (options?: { captureEventName?: false }) => void;
  opt_out_capturing: () => void;
  sessionRecording?: { startIfEnabledOrStop: () => void };
  conversations?: { reset: () => void };
}

const STORAGE_KEY = "mcpjam-analytics-consent";
const listeners = new Set<() => void>();

/**
 * Whether this visitor must opt in before optional analytics and session
 * replay run. The server decides from the visitor's country
 * (server/utils/analytics-consent.ts); a document it did not write into, such
 * as the Vite dev server's, counts as an unknown location and needs consent.
 */
export function isAnalyticsConsentRequired(): boolean {
  return (
    typeof window === "undefined" ||
    window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ !== false
  );
}

export function getAnalyticsConsent(): AnalyticsConsent | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === "granted" || stored === "denied" ? stored : null;
  } catch (error) {
    // Blocked storage reads as "no choice yet": the banner asks again and
    // analytics stay off, which is the safe side.
    console.debug("[analytics-consent] could not read the stored choice", error);
    return null;
  }
}

/**
 * Whether optional analytics may run for this visitor right now. A stored
 * refusal holds even where the server would not ask, so a visitor who declined
 * is not tracked after their location changes.
 */
export function hasAnalyticsConsent(): boolean {
  const consent = getAnalyticsConsent();
  if (consent !== null) return consent === "granted";
  return !isAnalyticsConsentRequired();
}

export function setAnalyticsConsent(
  client: AnalyticsConsentClient,
  consent: AnalyticsConsent,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, consent);
  } catch (error) {
    // The choice still applies to this page; it is asked again next visit.
    console.debug("[analytics-consent] could not store the choice", error);
  }
  if (consent === "granted") {
    client.opt_in_capturing({ captureEventName: false });
  } else {
    client.opt_out_capturing();
    // Outside cookieless mode, opting out leaves a running recorder and a
    // loaded Conversations widget in place. Re-checking stops the recorder
    // now that capture is off; reset removes the widget and its stored session.
    client.sessionRecording?.startIfEnabledOrStop();
    client.conversations?.reset();
  }
  for (const listener of listeners) listener();
}

/**
 * posthog-js `reset()` returns consent to the init default, which is opted out
 * for a visitor who needed consent. Restore a choice they already made.
 */
export function reapplyAnalyticsConsent(client: AnalyticsConsentClient): void {
  if (isAnalyticsConsentRequired() && getAnalyticsConsent() === "granted") {
    client.opt_in_capturing({ captureEventName: false });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnalyticsConsent(): AnalyticsConsent | null {
  return useSyncExternalStore(subscribe, getAnalyticsConsent, () => null);
}
