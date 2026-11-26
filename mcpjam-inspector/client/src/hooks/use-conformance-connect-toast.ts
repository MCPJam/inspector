import { useEffect, useLayoutEffect, useRef } from "react";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";
import type { startConnectToast } from "@/lib/connect-toast";

type ConnectToast = ReturnType<typeof startConnectToast>;

/**
 * Holds a connect's toast on "Connecting…" until the protocol check that
 * gates the steps settles, so "connected" shows only once Continue can be
 * used. Returns the call that hands a connected server's toast over.
 */
export function useConformanceConnectToast(
  serverName: string | null,
  check: { ready: boolean; result?: ConformanceConnectionResult },
) {
  // The result on screen when the connect landed is the last connection's,
  // so only a later one settles the toast.
  const latestResult = useRef(check.result);
  useLayoutEffect(() => {
    latestResult.current = check.result;
  });
  const held = useRef<{
    name: string;
    progress: ConnectToast;
    stale?: ConformanceConnectionResult;
  } | null>(null);

  useEffect(() => {
    const pending = held.current;
    if (!pending) return;
    const { ready, result } = check;
    const fresh = result !== pending.stale ? result : undefined;
    // Another server picked: this one's connect did succeed. No result
    // while ready: the server needs no protocol check.
    if (pending.name !== serverName || (ready && !result)) {
      held.current = null;
      pending.progress.connected();
      return;
    }
    if (!fresh) return;
    held.current = null;
    if (fresh.status === "ready") pending.progress.connected();
    // The refusal shows its own toast.
    else if (fresh.status === "unsupported") pending.progress.dismiss();
    else
      pending.progress.failed(
        fresh.status === "auth-required"
          ? `${pending.name} needs you to sign in. Sign in below to continue.`
          : fresh.message,
      );
  });

  // Left the steps while the check ran: the connect itself did succeed.
  useEffect(
    () => () => {
      held.current?.progress.connected();
      held.current = null;
    },
    [],
  );

  return (name: string, progress: ConnectToast) => {
    held.current?.progress.connected();
    held.current = { name, progress, stale: latestResult.current };
  };
}
