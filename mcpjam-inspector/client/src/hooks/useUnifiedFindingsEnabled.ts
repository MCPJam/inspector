/**
 * The unified-findings experiment's client flag.
 *
 * DEFAULT OFF, and deliberately NOT a PostHog flag like its neighbours. Two
 * reasons: the experiment has to be inspectable on a machine with no analytics
 * configured (the offline preview is the whole point), and Marcelo needs to be
 * able to turn it on for one browser without shipping a cohort.
 *
 * Two ways in, checked in this order:
 *   1. `VITE_UNIFIED_FINDINGS=1` in the Inspector's env — on for that build.
 *   2. `localStorage["mcpjam.experiment.unifiedFindings"] = "1"` — on for that
 *      browser, no restart of anything.
 *
 * `"1"` exactly. A flag that adds a surface takes a deliberate value, not a
 * truthy one — the same discipline the backend gate uses.
 *
 * Nothing else reads these two names. Flag off means the section is not
 * mounted at all, so a flag-off page issues no extra query and renders no
 * extra DOM.
 */
import { useEffect, useState } from "react";

export const UNIFIED_FINDINGS_ENV_FLAG = "VITE_UNIFIED_FINDINGS";
export const UNIFIED_FINDINGS_STORAGE_KEY = "mcpjam.experiment.unifiedFindings";

function readFlag(): boolean {
  if (import.meta.env?.[UNIFIED_FINDINGS_ENV_FLAG] === "1") return true;
  try {
    return window.localStorage.getItem(UNIFIED_FINDINGS_STORAGE_KEY) === "1";
  } catch {
    // Private mode, blocked storage, SSR — all mean "no flag", which is off.
    return false;
  }
}

export function useUnifiedFindingsEnabled(): boolean {
  const [enabled, setEnabled] = useState(readFlag);
  useEffect(() => {
    // Another tab (or the dev console) flipping the key should not need a
    // reload to take effect; `storage` fires only for OTHER documents, which
    // is exactly the case a reload would otherwise be needed for.
    const onStorage = (event: StorageEvent) => {
      if (event.key === UNIFIED_FINDINGS_STORAGE_KEY) setEnabled(readFlag());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return enabled;
}
