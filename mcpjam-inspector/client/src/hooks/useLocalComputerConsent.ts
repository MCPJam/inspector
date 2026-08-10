/**
 * React face of the local-computer consent capability (`lib/local-computer-consent.ts`).
 *
 * `granted` is a SYNCHRONOUS projection of localStorage: consent exists iff a
 * capability token is stored on this device. There is deliberately no
 * client-side verification loop — the server re-verifies the token on every
 * actual bash/terminal use (the engine resolver, PR #3812), so a stale or
 * tampered token just fails the next turn's server check and falls back. That
 * makes this hook a pure store projection (via `useSyncExternalStore`), which
 * has no async status to race: earlier versions that verified on mount grew
 * five rounds of out-of-order/self-supersede/cross-tab-clobber guards for no
 * safety the server wasn't already providing.
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
  clearStoredLocalComputerConsent,
  loadStoredLocalComputerConsent,
  mintLocalComputerConsent,
  persistLocalComputerConsent,
  revokeLocalComputerConsentOnServer,
  subscribeLocalComputerConsent,
} from "@/lib/local-computer-consent";

export type LocalComputerConsentStatus = "granted" | "absent";

export interface LocalComputerConsent {
  status: LocalComputerConsentStatus;
  /** `true` — a capability token is stored; safe to gate the engine on. */
  granted: boolean;
  /** The capability token to send as `X-MCPJam-Local-Consent`. */
  token: string | null;
  /** Mint + persist; resolves to whether consent ended up stored. */
  grant: () => Promise<boolean>;
  /** Forget locally (synchronously) + best-effort server unlink. */
  revoke: () => Promise<void>;
}

function getStoredToken(): string | null {
  if (HOSTED_MODE) return null;
  return loadStoredLocalComputerConsent()?.token ?? null;
}

function subscribe(callback: () => void): () => void {
  if (HOSTED_MODE) return () => {};
  return subscribeLocalComputerConsent(callback);
}

export function useLocalComputerConsent(): LocalComputerConsent {
  // A primitive string snapshot — value-compared by React, so writes from any
  // tab re-render and stale reads are impossible.
  const token = useSyncExternalStore(subscribe, getStoredToken, () => null);

  const grant = useCallback(async (): Promise<boolean> => {
    if (HOSTED_MODE) return false;
    const minted = await mintLocalComputerConsent();
    if (!minted) return false;
    // persist returns false when storage is blocked/full — then consent is NOT
    // stored, so we must report failure rather than a token nothing can read.
    // The successful persist fires a storage event → useSyncExternalStore
    // re-reads → status flips to granted; no optimistic write needed.
    const stored = persistLocalComputerConsent(minted);
    if (!stored) {
      // The mint already rotated the server capability to this token, and
      // nothing can ever present it now — release it (best-effort) rather
      // than leave an orphaned capability. Scoped to the minted token, so if
      // an even newer grant rotated again this is a no-op.
      void revokeLocalComputerConsentOnServer(minted.token);
    }
    return stored;
  }, []);

  const revoke = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    // Forget locally FIRST and synchronously — the user's explicit revoke,
    // and the only write that touches storage (fires the event → re-read →
    // absent). The server call is storage-free and best-effort, so a slow
    // revoke resuming later can't clobber a token a newer grant just stored;
    // it is also SCOPED to the token being forgotten, so on the server side a
    // delayed revoke can't sever a capability a newer grant rotated in.
    const stored = loadStoredLocalComputerConsent()?.token ?? null;
    clearStoredLocalComputerConsent();
    await revokeLocalComputerConsentOnServer(stored);
  }, []);

  return {
    status: token ? "granted" : "absent",
    granted: token != null,
    token,
    grant,
    revoke,
  };
}
