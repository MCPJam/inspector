import { useEffect, useRef } from "react";
import type { ConnectionStatus } from "@/state/app-types";

/** Long enough for SSO with MFA; shorter would end slow but real sign-ins. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

export const SIGN_IN_TIMED_OUT_MESSAGE =
  "Sign-in timed out. Reconnect to try again.";

/**
 * Ends every browser sign-in that is still waiting after SIGN_IN_TIMEOUT_MS.
 *
 * A timer belongs to one attempt, named by the server's op token when it
 * entered `oauth-flow`. Cancel and every new attempt bump the token, so a
 * timer that outlives its attempt fires into a different token and does
 * nothing.
 */
export function useSignInTimeout({
  servers,
  getOpToken,
  onTimeout,
}: {
  servers: Record<string, { connectionStatus: ConnectionStatus }>;
  getOpToken: (serverName: string) => number;
  onTimeout: (serverName: string) => void;
}): void {
  const timersRef = useRef(
    new Map<string, { token: number; timer: ReturnType<typeof setTimeout> }>(),
  );
  const getOpTokenRef = useRef(getOpToken);
  getOpTokenRef.current = getOpToken;
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    const timers = timersRef.current;
    for (const [name, entry] of timers) {
      if (servers[name]?.connectionStatus !== "oauth-flow") {
        clearTimeout(entry.timer);
        timers.delete(name);
      }
    }
    for (const [name, server] of Object.entries(servers)) {
      if (server.connectionStatus !== "oauth-flow") continue;
      const token = getOpTokenRef.current(name);
      const existing = timers.get(name);
      if (existing?.token === token) continue;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => {
        if (timers.get(name)?.timer === timer) timers.delete(name);
        if (getOpTokenRef.current(name) !== token) return;
        onTimeoutRef.current(name);
      }, SIGN_IN_TIMEOUT_MS);
      timers.set(name, { token, timer });
    }
  }, [servers]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const { timer } of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
}
