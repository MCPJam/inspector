import { useEffect, useState } from "react";
import { fetchLocalBrowserStatus } from "@/lib/local-browser/client";

/** How often to ask whether this machine has a browser open. */
export const LOCAL_BROWSER_PROBE_MS = 5_000;

/**
 * Is there a live browser on this machine right now?
 *
 * Polled rather than derived from the host config, because the thing that
 * opens one may not be this app: an agent running `mcpjam browser open` in
 * another process starts a browser this workspace should show. The status
 * route is consent-free and machine-anonymous — no paths, no profile
 * directories, no process ids — so asking it costs nothing a person has not
 * already agreed to.
 *
 * Off entirely on the hosted engine, where this route describes a machine that
 * is not the one running the browser.
 *
 * Lifted out of `PlaygroundRightRail` when the browser got its own panel: two
 * components now ask the same question, and two polls on one interval would be
 * two requests a second for one answer.
 */
export function useLocalBrowserRunning(enabled: boolean): boolean {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setRunning(false);
      return;
    }
    let cancelled = false;
    const probe = async () => {
      const status = await fetchLocalBrowserStatus().catch(() => null);
      if (!cancelled && status) setRunning(status.running === true);
    };
    void probe();
    const timer = window.setInterval(() => void probe(), LOCAL_BROWSER_PROBE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled]);
  return running;
}
