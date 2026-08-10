/**
 * React face of the local-computer consent capability (`lib/local-computer-consent.ts`).
 *
 * `granted` is SERVER-verified truth, not a localStorage bit: on mount (and
 * whenever the stored token changes) the hook re-verifies against
 * `/api/mcp/computers/local-consent/verify`. Until that answer lands the
 * status is `"unknown"`, which consumers must treat as not-granted — the
 * engine resolution in `useComputerEngine` only honors `"granted"`.
 *
 * Hosted mode short-circuits to `"absent"` forever: there is no local
 * machine to consent to, and the server routes don't exist there anyway.
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { HOSTED_MODE } from "@/lib/config";
import {
  clearStoredLocalComputerConsent,
  grantLocalComputerConsent,
  loadStoredLocalComputerConsent,
  revokeLocalComputerConsent,
  subscribeLocalComputerConsent,
  verifyStoredLocalComputerConsent,
} from "@/lib/local-computer-consent";

export type LocalComputerConsentStatus = "unknown" | "granted" | "absent";

export interface LocalComputerConsent {
  status: LocalComputerConsentStatus;
  /** `status === "granted"` — server-verified, safe to gate the engine on. */
  granted: boolean;
  /** The verified capability token to send as `X-MCPJam-Local-Consent`. */
  token: string | null;
  grant: () => Promise<boolean>;
  revoke: () => Promise<void>;
}

export function useLocalComputerConsent(): LocalComputerConsent {
  const { getAccessToken } = useAuth();
  const [status, setStatus] = useState<LocalComputerConsentStatus>(
    HOSTED_MODE ? "absent" : "unknown",
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    if (!loadStoredLocalComputerConsent()) {
      setStatus("absent");
      return;
    }
    let accessToken: string | undefined;
    try {
      accessToken = await getAccessToken?.();
    } catch {
      // Not signed in — the consent routes require a verified bearer.
    }
    if (!accessToken) {
      setStatus("absent");
      return;
    }
    const valid = await verifyStoredLocalComputerConsent(accessToken);
    setStatus(valid ? "granted" : "absent");
  }, [getAccessToken]);

  useEffect(() => {
    if (HOSTED_MODE) return;
    void refresh();
    return subscribeLocalComputerConsent(() => {
      void refresh();
    });
  }, [refresh]);

  const grant = useCallback(async (): Promise<boolean> => {
    if (HOSTED_MODE) return false;
    let accessToken: string | undefined;
    try {
      accessToken = await getAccessToken?.();
    } catch {
      return false;
    }
    if (!accessToken) return false;
    const ok = await grantLocalComputerConsent(accessToken);
    // The persist inside grant fires the subscription → refresh → verified
    // "granted"; set optimistically so the Allow click feels immediate.
    if (ok) setStatus("granted");
    return ok;
  }, [getAccessToken]);

  const revoke = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    // Forget the capability locally FIRST and unconditionally — this is the
    // user's explicit revoke. If we skipped it when getAccessToken threw (a
    // transient auth refresh), the still-valid stored token would survive and
    // a later remount could re-verify it and silently restore consent. The
    // server call is best-effort on top of the guaranteed local forget.
    clearStoredLocalComputerConsent();
    setStatus("absent");
    let accessToken: string | undefined;
    try {
      accessToken = await getAccessToken?.();
    } catch {
      accessToken = undefined;
    }
    if (accessToken) {
      await revokeLocalComputerConsent(accessToken);
    }
  }, [getAccessToken]);

  return {
    status,
    granted: status === "granted",
    token: status === "granted"
      ? (loadStoredLocalComputerConsent()?.token ?? null)
      : null,
    grant,
    revoke,
  };
}
