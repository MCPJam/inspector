import { useSyncExternalStore } from "react";
import { POSTHOG_TAB_STORAGE_KEY } from "./posthog-tab-storage";

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
  is_capturing: () => boolean;
  clear_opt_in_out_capturing: () => void;
  set_config: (config: {
    disable_conversations: boolean;
    opt_out_capturing_by_default: boolean;
    opt_out_persistence_by_default: boolean;
  }) => void;
  sessionRecording?: { startIfEnabledOrStop: () => void };
  conversations?: { reset: () => void };
}

const STORAGE_KEY = "mcpjam-analytics-consent";
const listeners = new Set<() => void>();
// A choice the browser refused to store. It wins over storage, so it holds on
// this page instead of the stale stored one.
let pageChoice: AnalyticsConsent | null = null;
// The PostHog instance a choice made in another tab is applied to.
let followedClient: AnalyticsConsentClient | null = null;

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
  if (pageChoice !== null) return pageChoice;
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
    pageChoice = null;
  } catch (error) {
    // The choice still applies to this page; it is asked again next visit.
    pageChoice = consent;
    console.debug("[analytics-consent] could not store the choice", error);
    // Storage that refuses writes may still allow removal. Dropping the earlier
    // grant keeps it from deciding the next visit.
    if (consent === "denied") forgetStoredChoice();
  }
  applyToClient(client, consent);
  notify();
}

function forgetStoredChoice(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.debug("[analytics-consent] could not remove the stored choice", error);
  }
}

function applyToClient(
  client: AnalyticsConsentClient,
  consent: AnalyticsConsent | null,
): void {
  // Without a choice, this location's default decides.
  const refused =
    consent === null ? isAnalyticsConsentRequired() : consent !== "granted";
  if (consent === "denied") client.opt_out_capturing();
  else if (consent === "granted") {
    client.opt_in_capturing({ captureEventName: false });
  }
  // posthog-js read these getters once at init. A remote config that lands
  // later would reload Conversations, and `reset()` deletes the stored choice
  // and falls back to the opt-out defaults, unless the live config carries
  // the current choice. Persistence off also removes what PostHog stored.
  client.set_config({
    disable_conversations: refused,
    opt_out_capturing_by_default: refused,
    opt_out_persistence_by_default: refused,
  });
  // posthog-js keeps the choice it stored for an earlier document, and one it
  // could not store leaves it reading the earlier one. Removing that leaves
  // the default set above in charge.
  if (consent === null || client.is_capturing() === refused) {
    client.clear_opt_in_out_capturing();
  }
  if (!refused) return;
  forgetTabWindowId();
  // Outside cookieless mode, opting out leaves a running recorder and a
  // loaded Conversations widget in place. Re-checking stops the recorder
  // now that capture is off; reset removes the widget and its stored session.
  client.sessionRecording?.startIfEnabledOrStop();
  client.conversations?.reset();
}

// posthog-js keeps this tab's window id in sessionStorage after persistence
// is turned off, and reads it back on the next load.
function forgetTabWindowId(): void {
  try {
    window.sessionStorage.removeItem(`${POSTHOG_TAB_STORAGE_KEY}_window_id`);
  } catch (error) {
    console.debug("[analytics-consent] could not remove the tab window id", error);
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * posthog-js `reset()` returns consent to its default, which may be opted out
 * from a refusal made earlier. Restore a grant the visitor made, wherever
 * they are now.
 */
export function reapplyAnalyticsConsent(client: AnalyticsConsentClient): void {
  if (getAnalyticsConsent() === "granted") {
    client.opt_in_capturing({ captureEventName: false });
  }
}

/**
 * Applies a choice made in another open tab to `client` here too, so a
 * withdrawal there also stops this tab's recorder and replay. Call it once
 * posthog-js has loaded.
 */
export function followAnalyticsConsentAcrossTabs(
  client: AnalyticsConsentClient,
): void {
  followedClient = client;
  // A choice posthog-js stored for an earlier document, possibly in another
  // region, must not outlive the visitor's own choice being cleared.
  if (getAnalyticsConsent() === null) client.clear_opt_in_out_capturing();
}

// Some test and embedded hosts stand in a `window` without events.
if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  window.addEventListener("storage", (event) => {
    // `key` is null when another tab cleared all of storage.
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    pageChoice = null;
    // A cleared store applies this location's default without storing it as
    // a choice: off where the visitor must opt in, on where they need not.
    if (followedClient) applyToClient(followedClient, getAnalyticsConsent());
    notify();
  });
}

/** Calls `listener` after every choice, made in this tab or another. */
export function subscribeAnalyticsConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAnalyticsConsent(): AnalyticsConsent | null {
  return useSyncExternalStore(
    subscribeAnalyticsConsent,
    getAnalyticsConsent,
    () => null,
  );
}
