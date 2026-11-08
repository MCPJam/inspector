import { useEffect, useRef } from "react";

export const SANDBOX_READY_TIMEOUT_MS = 30_000;

/** Bound the proxy handshake without retrying the app or its originating tool. */
export function useSandboxReadyDeadline({
  waiting,
  identity,
  onTimeout,
}: {
  waiting: boolean;
  identity: string;
  onTimeout: () => void;
}): void {
  const callback = useRef(onTimeout);
  callback.current = onTimeout;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(
      () => callback.current(),
      SANDBOX_READY_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [waiting, identity]);
}
