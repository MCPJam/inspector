import { useCallback, useMemo, useSyncExternalStore } from "react";
import { HOSTED_MODE } from "@/lib/config";
import {
  loadBrowserEngine,
  saveBrowserEngine,
  subscribeBrowserEngine,
  type BrowserEngineChoice,
} from "@/lib/browser-engine-storage";
import { useLocalBrowserConsent } from "./useLocalBrowserConsent";
import { useLocalBrowserEnabled } from "./useComputersEnabled";
import { useComputersDataPlaneConfig } from "./useProjectComputer";

/** Selection is independent of consent and readiness: never silently move a browser. */
export function useBrowserEngine(projectId: string | null) {
  const config = useComputersDataPlaneConfig();
  const consent = useLocalBrowserConsent();
  const enabled = useLocalBrowserEnabled();
  const { subscribe, getSnapshot } = useMemo(
    () =>
      !HOSTED_MODE && projectId
        ? {
            subscribe: (cb: () => void) =>
              subscribeBrowserEngine(projectId, cb),
            getSnapshot: () => loadBrowserEngine(projectId),
          }
        : { subscribe: () => () => {}, getSnapshot: () => null },
    [projectId],
  );
  const preference = useSyncExternalStore(subscribe, getSnapshot, () => null);
  const setEngine = useCallback(
    (engine: BrowserEngineChoice) => {
      if (!HOSTED_MODE && projectId) saveBrowserEngine(projectId, engine);
    },
    [projectId],
  );
  const selectedEngine: BrowserEngineChoice = HOSTED_MODE
    ? "cloud"
    : preference ?? "local";
  const localAvailable =
    !HOSTED_MODE && enabled && config?.engines.local.browserAvailable === true;
  const cloudAvailable = config?.engines.cloud.available ?? false;
  return {
    engine: selectedEngine,
    selectedEngine,
    setEngine,
    resolved: config !== undefined,
    localAvailable,
    cloudAvailable,
    toggleVisible: !HOSTED_MODE,
    consent,
  };
}
export type BrowserEngineState = ReturnType<typeof useBrowserEngine>;
