/**
 * React face of the local-browser consent capability (`lib/local-browser-consent.ts`).
 *
 * Readiness projects the stored capability and pending shared setup. Mounting
 * never grants permission, verifies a token, or changes client settings. Only
 * an explicit Allow verifies/reuses or mints a capability and enables clients.
 * The server still verifies the token on every actual Browser use.
 *
 * Reads reflect writes from any tab/hook immediately (same-tab custom event +
 * cross-tab storage event); concurrent grant/revoke are plain last-write-wins
 * on localStorage, which is the honest semantics for "did the user allow this
 * on this device".
 *
 * Hosted mode short-circuits to `"absent"`: there is no local machine to
 * consent to, and the server routes don't exist there.
 */
import { useCallback, useSyncExternalStore } from "react";
import { HOSTED_MODE } from "@/lib/config";
import {
  clearStoredLocalBrowserConsent,
  loadStoredLocalBrowserConsent,
  enableLocalBrowserForAllClients,
  localBrowserSetupPending,
  revokeLocalBrowserConsentOnServer,
  subscribeLocalBrowserConsent,
} from "@/lib/local-browser-consent";

export type LocalBrowserConsentStatus = "granted" | "absent";

export interface LocalBrowserConsent {
  status: LocalBrowserConsentStatus;
  /** A capability is stored and explicit shared setup is not pending. */
  granted: boolean;
  /** The capability token to send as `X-MCPJam-Browser-Consent`. */
  token: string | null;
  /** Explicitly allow device access and enable shared local-client settings. */
  grant: () => Promise<boolean>;
  /** Forget locally (synchronously) + best-effort server unlink. */
  revoke: () => Promise<void>;
}

function getStoredToken(): string | null {
  if (HOSTED_MODE) return null;
  return loadStoredLocalBrowserConsent()?.token ?? null;
}

function subscribe(callback: () => void): () => void {
  if (HOSTED_MODE) return () => {};
  return subscribeLocalBrowserConsent(callback);
}

export function useLocalBrowserConsent(): LocalBrowserConsent {
  // A primitive string snapshot — value-compared by React, so writes from any
  // tab re-render and stale reads are impossible.
  const token = useSyncExternalStore(subscribe, getStoredToken, () => null);
  const setupPending = useSyncExternalStore(
    subscribe,
    localBrowserSetupPending,
    () => false,
  );

  const grant = useCallback(async (): Promise<boolean> => {
    if (HOSTED_MODE) return false;
    return enableLocalBrowserForAllClients();
  }, []);

  const revoke = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    // Forget locally FIRST and synchronously — the user's explicit revoke,
    // and the only write that touches storage (fires the event → re-read →
    // absent). The server call is storage-free and best-effort, so a slow
    // revoke resuming later can't clobber a token a newer grant just stored;
    // it is also SCOPED to the token being forgotten, so on the server side a
    // delayed revoke can't sever a capability a newer grant rotated in.
    const stored = loadStoredLocalBrowserConsent()?.token ?? null;
    clearStoredLocalBrowserConsent();
    await revokeLocalBrowserConsentOnServer(stored);
  }, []);

  return {
    status: token && !setupPending ? "granted" : "absent",
    granted: token != null && !setupPending,
    token,
    grant,
    revoke,
  };
}
