import { usePreviewedEnvironmentId } from "./use-previewed-environment-id";
import { useProjectEnvironmentsEnabled } from "./useProjectEnvironmentsEnabled";
import { useActiveChatSessionStore } from "@/stores/active-chat-session-store";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { useAuth } from "@workos-inc/authkit-react";
import {
  loadBrowserEngine,
  saveBrowserEngine,
  subscribeBrowserEngine,
  type BrowserEngineChoice,
} from "@/lib/browser-engine-storage";
import { useLocalBrowserConsent } from "./useLocalBrowserConsent";
import {
  useLocalBrowserEnabled,
  useHostedBrowserEnabled,
} from "./useComputersEnabled";
import { useComputersDataPlaneConfig } from "./useProjectComputer";

/** Selection is independent of consent and readiness: never silently move a browser. */
export function useBrowserEngine(
  projectId: string | null,
  scope: "conversation" | "preference" = "conversation",
) {
  const { user } = useAuth();
  const config = useComputersDataPlaneConfig();
  const consent = useLocalBrowserConsent();
  const enabled = useLocalBrowserEnabled();
  const hostedEnabled = useHostedBrowserEnabled();
  const [environmentId] = usePreviewedEnvironmentId(projectId);
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environmentMode =
    scope === "conversation" && environmentsEnabled && Boolean(environmentId);
  const boundLocation = useActiveChatSessionStore((state) =>
    state.browserLocation?.projectId === projectId &&
    state.browserLocation.sessionId === state.sessionId
      ? state.browserLocation.engine
      : null,
  );
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
      if (!HOSTED_MODE && !environmentMode && projectId)
        saveBrowserEngine(projectId, engine);
    },
    [projectId, environmentMode],
  );
  // Rollout chooses the default; explicit/bound local selection still needs
  // truthful server readiness so users can grant Browser permission.
  const localAvailable =
    !HOSTED_MODE &&
    !environmentMode &&
    config?.engines.local.browserAvailable === true;
  // Only an explicit preference or a bound conversation survives loss of
  // candidacy. An unseeded rollout continues using the existing Cloud path.
  const selectedEngine: BrowserEngineChoice =
    HOSTED_MODE || environmentMode
      ? "cloud"
      : (scope === "conversation" ? boundLocation : null) ??
        preference ??
        (enabled && localAvailable ? "local" : "cloud");
  const cloudAvailable =
    Boolean(user) && hostedEnabled && config?.engines.cloud.available === true;
  return {
    engine: selectedEngine,
    selectedEngine,
    setEngine,
    resolved: config !== undefined,
    localAvailable,
    cloudAvailable,
    // Same rule as the Computer tab: a location picker only exists when
    // both engines are real options. `cloudAvailable` already includes the
    // hosted-browser rollout, so a local-only launch never offers Cloud.
    toggleVisible:
      !HOSTED_MODE && !environmentMode && localAvailable && cloudAvailable,
    environmentMode,
    consent,
  };
}
export type BrowserEngineState = ReturnType<typeof useBrowserEngine>;
