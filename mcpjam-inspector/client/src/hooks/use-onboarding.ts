import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useMutation } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";
import type { OnboardingPhase } from "@/lib/onboarding-state";
import {
  readOnboardingState,
  writeOnboardingState,
} from "@/lib/onboarding-state";
import {
  EXCALIDRAW_SERVER_CONFIG,
  EXCALIDRAW_SERVER_NAME,
} from "@/lib/excalidraw-quick-connect";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";

interface UseOnboardingOptions {
  servers: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  isAuthenticated: boolean;
  isAuthLoading: boolean;
}

interface UseOnboardingReturn {
  phase: OnboardingPhase;
  isGuidedPostConnect: boolean;
  isResolvingRemoteCompletion: boolean;
  /** True before the Excalidraw server row exists (auto-connect not yet dispatched). */
  isBootstrappingFirstRunConnection: boolean;
  connectExcalidraw: () => void;
  completeOnboarding: () => void;
  connectError: string | null;
  retryConnect: () => void;
}

function getInitialLocalPhase(
  servers: Record<string, ServerWithName>,
  isAuthenticated: boolean,
  isAuthLoading: boolean,
): OnboardingPhase {
  if (isAuthLoading) return "dismissed";
  if (isAuthenticated) return "completed";

  const persisted = readOnboardingState();
  if (persisted?.status === "completed") return "completed";
  if (persisted?.status === "dismissed") return "dismissed";

  const hasAnyServers = Object.keys(servers).length > 0;
  if (!hasAnyServers && (!persisted || persisted.status === "seen")) {
    return "connecting_excalidraw";
  }

  return "dismissed";
}

export function useOnboarding({
  servers,
  onConnect,
  isAuthenticated,
  isAuthLoading,
}: UseOnboardingOptions): UseOnboardingReturn {
  const posthog = usePostHog();
  const completeOnboardingMutation = useMutation(
    "users:completeOnboarding" as any,
  );
  const trackingProps = useMemo(
    () => ({
      platform: detectPlatform(),
      environment: detectEnvironment(),
    }),
    [],
  );

  const [phase, setPhase] = useState<OnboardingPhase>(() =>
    getInitialLocalPhase(servers, isAuthenticated, isAuthLoading),
  );

  const [connectError, setConnectError] = useState<string | null>(null);
  const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
  const hasConnectedExcalidraw =
    excalidrawServer?.connectionStatus === "connected";
  const isResolvingRemoteCompletion = isAuthLoading;

  const didAutoConnectRef = useRef(false);

  // Track first-run eligible once when auto-connect begins.
  const didTrackFirstRun = useRef(false);

  const persistCompletedState = useCallback(() => {
    writeOnboardingState({ status: "completed", completedAt: Date.now() });
    if (isAuthenticated) {
      completeOnboardingMutation().catch(() => {});
    }
  }, [completeOnboardingMutation, isAuthenticated]);

  useEffect(() => {
    if (isAuthLoading) {
      return;
    }

    if (isAuthenticated) {
      setPhase("completed");
      return;
    }

    setPhase((currentPhase) => {
      if (currentPhase !== "dismissed") {
        return currentPhase;
      }

      return getInitialLocalPhase(servers, false, false);
    });
  }, [servers, isAuthLoading, isAuthenticated]);

  // First-run guests: auto-connect Excalidraw in the background (no welcome overlay).
  useEffect(() => {
    if (isAuthLoading || isAuthenticated) return;
    if (didAutoConnectRef.current) return;

    const persisted = readOnboardingState();
    if (
      persisted?.status === "completed" ||
      persisted?.status === "dismissed"
    ) {
      return;
    }
    if (Object.keys(servers).length > 0) return;
    if (phase !== "connecting_excalidraw") return;

    didAutoConnectRef.current = true;
    if (!didTrackFirstRun.current) {
      didTrackFirstRun.current = true;
      writeOnboardingState({ status: "seen" });
      posthog.capture("onboarding_first_run_eligible", trackingProps);
    }
    setConnectError(null);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
    posthog.capture("onboarding_connect_excalidraw_auto", trackingProps);
  }, [phase, servers, isAuthLoading, isAuthenticated, onConnect, posthog]);

  // Monitor server connection for Excalidraw after connect is requested
  useEffect(() => {
    if (phase !== "connecting_excalidraw") return;

    if (excalidrawServer?.connectionStatus === "connected") {
      setPhase("connected_guided");
      setConnectError(null);
      posthog.capture("onboarding_connect_excalidraw_success", trackingProps);
    } else if (excalidrawServer?.lastError) {
      setPhase("connect_error");
      setConnectError(
        excalidrawServer.lastError || "Failed to connect to Excalidraw",
      );
      posthog.capture("onboarding_connect_excalidraw_error", {
        ...trackingProps,
        error: excalidrawServer.lastError,
      });
    }
  }, [excalidrawServer, phase]);

  const connectExcalidraw = useCallback(() => {
    setPhase("connecting_excalidraw");
    setConnectError(null);
    posthog.capture("onboarding_connect_excalidraw_clicked", trackingProps);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
  }, [onConnect, posthog, trackingProps]);

  const completeOnboarding = useCallback(() => {
    persistCompletedState();
    setPhase("completed");
    posthog.capture("onboarding_completed", trackingProps);
  }, [persistCompletedState, posthog, trackingProps]);

  const retryConnect = useCallback(() => {
    setPhase("connecting_excalidraw");
    setConnectError(null);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
  }, [onConnect]);

  useEffect(() => {
    if (phase !== "connect_error" || !connectError) {
      toast.dismiss("excalidraw-connect-error");
      return;
    }
    toast.error(connectError, {
      id: "excalidraw-connect-error",
      action: {
        label: "Retry",
        onClick: () => {
          retryConnect();
        },
      },
    });
  }, [phase, connectError, retryConnect]);

  const isTransitioningToGuided =
    phase === "connecting_excalidraw" && hasConnectedExcalidraw;

  const isGuidedPostConnect =
    phase === "connected_guided" || isTransitioningToGuided;

  const isBootstrappingFirstRunConnection =
    phase === "connecting_excalidraw" && !servers[EXCALIDRAW_SERVER_NAME];

  return {
    phase,
    isGuidedPostConnect,
    isResolvingRemoteCompletion,
    isBootstrappingFirstRunConnection,
    connectExcalidraw,
    completeOnboarding,
    connectError,
    retryConnect,
  };
}
