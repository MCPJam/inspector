import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { HOSTED_MODE } from "@/lib/config";
import type { AppReadyStatus } from "@/lib/app-ready";

/**
 * Single source of truth for "is this app ready to dispatch a request?".
 *
 * Both modes follow the same lifecycle (bootstrap → ready → request); the only
 * thing that varies is which signals contribute. Surfaces that initiate
 * hosted/local requests consult `useAppReady()` and disable their controls
 * while the status is `bootstrapping`. Request builders defensively throw
 * `BootstrapNotReadyError` if invoked while not-ready.
 */

const DEFAULT_STATUS: AppReadyStatus = {
  status: "bootstrapping",
  reason: "loading-app-state",
};

const AppReadyContext = createContext<AppReadyStatus>(DEFAULT_STATUS);

export interface AppReadyProviderProps {
  children: ReactNode;
  /** True while the local appState hydration from storage is still running. */
  isLoadingAppState: boolean;
  /** Hosted only — true while Convex is establishing the auth handshake. */
  isConvexAuthLoading: boolean;
  /** Hosted only — true once Convex has confirmed the JWT (guest or WorkOS). */
  isConvexAuthenticated: boolean;
  /**
   * Hosted only — the resolved project id, or `"none"` while the project is
   * still being provisioned/loaded.
   */
  effectiveActiveProjectId: string;
}

/**
 * Debug escape hatch: setting `window.__mcpjamForceReady = true` in the
 * console (then triggering a re-render — typing into any input or clicking
 * any button works) forces the predicate to report `ready`, regardless of
 * upstream signals. Useful when a dev environment can't complete bootstrap
 * (e.g., Convex guest auth misconfigured) and you need to test the rest
 * of the app. Requests will still fail downstream — but they'll fail with
 * the actual upstream error, not a confusing "Finishing setup..." block.
 *
 * For an immediate effect without waiting for a re-render, also set
 * `localStorage.setItem('mcpjamForceReady', '1')` and reload the page.
 */
function readForceReadyOverride(): boolean {
  if (typeof window === "undefined") return false;
  if (
    (window as unknown as { __mcpjamForceReady?: boolean })
      .__mcpjamForceReady === true
  ) {
    return true;
  }
  try {
    return window.localStorage?.getItem("mcpjamForceReady") === "1";
  } catch {
    return false;
  }
}

export function AppReadyProvider({
  children,
  isLoadingAppState,
  isConvexAuthLoading,
  isConvexAuthenticated,
  effectiveActiveProjectId,
}: AppReadyProviderProps) {
  const value = useMemo<AppReadyStatus>(() => {
    if (readForceReadyOverride()) {
      return {
        status: "ready",
        projectId:
          effectiveActiveProjectId && effectiveActiveProjectId !== "none"
            ? effectiveActiveProjectId
            : null,
      };
    }
    if (isLoadingAppState) {
      return { status: "bootstrapping", reason: "loading-app-state" };
    }
    if (!HOSTED_MODE) {
      return { status: "ready", projectId: null };
    }
    if (isConvexAuthLoading || !isConvexAuthenticated) {
      return { status: "bootstrapping", reason: "resolving-auth" };
    }
    if (!effectiveActiveProjectId || effectiveActiveProjectId === "none") {
      return { status: "bootstrapping", reason: "provisioning-project" };
    }
    return { status: "ready", projectId: effectiveActiveProjectId };
  }, [
    isLoadingAppState,
    isConvexAuthLoading,
    isConvexAuthenticated,
    effectiveActiveProjectId,
  ]);

  // Dev diagnostic: log/expose the resolved state so a user stuck on
  // "Finishing setup..." can tell whether auth or project provisioning is
  // the blocker without React DevTools.
  const lastLoggedRef = useRef<string | null>(null);
  useEffect(() => {
    const snapshot = {
      status: value.status,
      reason: value.status === "bootstrapping" ? value.reason : null,
      projectId: value.status === "ready" ? value.projectId : null,
      signals: {
        isLoadingAppState,
        isConvexAuthLoading,
        isConvexAuthenticated,
        effectiveActiveProjectId,
        HOSTED_MODE,
      },
    };
    const key = JSON.stringify(snapshot);
    if (import.meta.env.DEV && key !== lastLoggedRef.current) {
      lastLoggedRef.current = key;
      // eslint-disable-next-line no-console
      console.info("[AppReady]", snapshot);
    }
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as unknown as { __mcpjamAppReady?: typeof snapshot })
        .__mcpjamAppReady = snapshot;
    }
  }, [
    value,
    isLoadingAppState,
    isConvexAuthLoading,
    isConvexAuthenticated,
    effectiveActiveProjectId,
  ]);

  return createElement(AppReadyContext.Provider, { value }, children);
}

export function useAppReady(): AppReadyStatus {
  return useContext(AppReadyContext);
}

/**
 * Human-readable reason string for "Finishing setup..." UI affordances.
 * Returns null when the app is ready. Each reason maps to a distinct
 * message so a user stuck on a toast can see which upstream signal is
 * the blocker (and tell us when triaging).
 */
export function useAppReadyMessage(): string | null {
  const state = useAppReady();
  if (state.status === "ready") return null;
  switch (state.reason) {
    case "loading-app-state":
      return "Loading saved state…";
    case "resolving-auth":
      return "Connecting to backend…";
    case "provisioning-project":
      return "Setting up workspace…";
  }
}
