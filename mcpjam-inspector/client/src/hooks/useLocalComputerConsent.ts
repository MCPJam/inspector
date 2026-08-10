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
  loadStoredLocalComputerConsent,
  mintLocalComputerConsent,
  persistLocalComputerConsent,
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

interface ConsentSnapshot {
  status: LocalComputerConsentStatus;
  token: string | null;
}

export function useLocalComputerConsent(): LocalComputerConsent {
  // status AND token live together in state, so a token rotation that keeps
  // status "granted" (tab B rotated A→B) still forces a re-render and the
  // returned `token` follows — reading it from storage at render time would
  // go stale whenever React bailed on the same-value status update.
  const [snapshot, setSnapshot] = useState<ConsentSnapshot>(
    HOSTED_MODE
      ? { status: "absent", token: null }
      : { status: "unknown", token: null },
  );
  // Monotonic sequence guarding every write. Verify, grant, and revoke all
  // resolve asynchronously and can complete out of order (mount + storage
  // event + an explicit grant race routinely); each op CLAIMS its slot
  // synchronously and only the latest-claimed op may write. That ordering —
  // claim-before-await — is what makes a later revoke beat an earlier in-flight
  // grant, not merely a faster one.
  const opSeqRef = useRef(0);
  // Local storage writes dispatch the same-tab consent event SYNCHRONOUSLY, so
  // the subscription below would re-enter refresh() and bump the sequence for
  // OUR OWN write, making an op supersede itself. This depth counter marks the
  // SYNCHRONOUS write region we cause; while it's non-zero the subscription
  // ignores the notification (we set the resulting state directly).
  //
  // Critically, it wraps only the synchronous persist/clear — NEVER a network
  // await. An external revoke (another tab/hook) arriving while a grant's
  // request is still in flight must stay visible, so it can advance the
  // sequence and make the completing grant discard itself.
  const selfWriteDepthRef = useRef(0);
  const selfWrite = useCallback(<T>(write: () => T): T => {
    selfWriteDepthRef.current += 1;
    try {
      return write();
    } finally {
      selfWriteDepthRef.current -= 1;
    }
  }, []);
  const apply = useCallback((seq: number, next: ConsentSnapshot) => {
    if (seq !== opSeqRef.current) return;
    setSnapshot((prev) =>
      prev.status === next.status && prev.token === next.token ? prev : next,
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    const seq = ++opSeqRef.current;
    if (!loadStoredLocalComputerConsent()) {
      apply(seq, { status: "absent", token: null });
      return;
    }
    const valid = await verifyStoredLocalComputerConsent();
    // Re-read after verify — a concurrent grant may have rotated the token;
    // whatever is stored now is the capability this "granted" refers to.
    const token = loadStoredLocalComputerConsent()?.token ?? null;
    apply(
      seq,
      valid && token
        ? { status: "granted", token }
        : { status: "absent", token: null },
    );
  }, [apply]);

  useEffect(() => {
    if (HOSTED_MODE) return;
    void refresh();
    return subscribeLocalComputerConsent(() => {
      // Ignore the storage notification our own grant/revoke just caused.
      if (selfWriteDepthRef.current > 0) return;
      void refresh();
    });
  }, [refresh]);

  const grant = useCallback(async (): Promise<boolean> => {
    if (HOSTED_MODE) return false;
    // CLAIM before awaiting: a revoke that starts after this line gets a higher
    // sequence and wins, even if the grant request resolves later.
    const seq = ++opSeqRef.current;
    // Mint on the server WITHOUT persisting — the network wait is UNGUARDED so
    // an external revoke during it stays visible and advances the sequence.
    const minted = await mintLocalComputerConsent();
    if (!minted) return false;
    if (seq !== opSeqRef.current) {
      // A genuinely later op (a revoke, possibly cross-tab) landed while the
      // mint was in flight. Do NOT persist; drop the just-minted server
      // capability so the later revoke stays final.
      void revokeLocalComputerConsent();
      return false;
    }
    // Persist is synchronous and fires the same-tab event — guard only THIS.
    selfWrite(() => persistLocalComputerConsent(minted));
    apply(seq, { status: "granted", token: minted.token });
    return true;
  }, [apply, selfWrite]);

  const revoke = useCallback(async (): Promise<void> => {
    if (HOSTED_MODE) return;
    // Claim the latest slot, then forget the capability locally FIRST and
    // unconditionally — this is the user's explicit revoke. The higher
    // sequence makes any in-flight grant/verify discard itself on resolve; the
    // server call is best-effort on top of the guaranteed local forget.
    const seq = ++opSeqRef.current;
    selfWrite(() => clearStoredLocalComputerConsent());
    apply(seq, { status: "absent", token: null });
    await revokeLocalComputerConsent();
  }, [apply, selfWrite]);

  return {
    status: snapshot.status,
    granted: snapshot.status === "granted",
    token: snapshot.status === "granted" ? snapshot.token : null,
    grant,
    revoke,
  };
}
