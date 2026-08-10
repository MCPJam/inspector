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
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [status, setStatus] = useState<LocalComputerConsentStatus>(
    HOSTED_MODE ? "absent" : "unknown",
  );
  // Monotonic sequence guarding every status write. Verify, grant, and revoke
  // all resolve asynchronously and can complete out of order (mount + storage
  // event + an explicit grant race routinely); only the LATEST-initiated
  // operation may write status, so a slow stale verify can never restore
  // `granted` after a revoke, nor "absent" after a fresh grant.
  const opSeqRef = useRef(0);
  const commit = useCallback(
    (seq: number, next: LocalComputerConsentStatus) => {
      if (seq === opSeqRef.current) setStatus(next);
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    const seq = ++opSeqRef.current;
    if (!loadStoredLocalComputerConsent()) {
      commit(seq, "absent");
      return;
    }
    const valid = await verifyStoredLocalComputerConsent();
    commit(seq, valid ? "granted" : "absent");
  }, [commit]);

  useEffect(() => {
    if (HOSTED_MODE) return;
    void refresh();
    return subscribeLocalComputerConsent(() => {
      void refresh();
    });
  }, [refresh]);

  const grant = useCallback(async (): Promise<boolean> => {
    if (HOSTED_MODE) return false;
    const ok = await grantLocalComputerConsent();
    // Claim the latest slot so an in-flight refresh can't overwrite this.
    // grant's persist fired the subscription → a refresh will re-confirm
    // "granted"; this just makes the Allow click feel immediate.
    if (ok) commit(++opSeqRef.current, "granted");
    return ok;
  }, [commit]);

  const revoke = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    // Forget the capability locally FIRST and unconditionally — this is the
    // user's explicit revoke — and claim the latest op slot so any in-flight
    // verify (older seq) can't restore consent. The server call is best-effort
    // on top of the guaranteed local forget.
    clearStoredLocalComputerConsent();
    commit(++opSeqRef.current, "absent");
    await revokeLocalComputerConsent();
  }, [commit]);

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
