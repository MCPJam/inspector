import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { usePostHog } from "posthog-js/react";
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
  isOverlayVisible: boolean;
  isGuidedPostConnect: boolean;
  isResolvingRemoteCompletion: boolean;
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
  if (!hasAnyServers && !persisted) {
    return "welcome";
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
  const trackingProps = {
    platform: detectPlatform(),
    environment: detectEnvironment(),
  };

  const [phase, setPhase] = useState<OnboardingPhase>(() =>
    getInitialLocalPhase(servers, isAuthenticated, isAuthLoading),
  );

  const [connectError, setConnectError] = useState<string | null>(null);
  const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
  const hasConnectedExcalidraw =
    excalidrawServer?.connectionStatus === "connected";
  const isResolvingRemoteCompletion = isAuthLoading;

  // Track first-run eligible on mount once the guest welcome state settles.
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

    if (phase === "connected_guided") {
      return;
    }

    const persisted = readOnboardingState();
    if (persisted?.status === "completed") {
      setPhase("completed");
    }
  }, [isAuthLoading, isAuthenticated, phase]);

  useEffect(() => {
    if (
      !isAuthenticated &&
      !isAuthLoading &&
      phase === "welcome" &&
      !didTrackFirstRun.current
    ) {
      didTrackFirstRun.current = true;
      writeOnboardingState({ status: "seen" });
      posthog.capture("onboarding_first_run_eligible", trackingProps);
    }
  }, [isAuthLoading, isAuthenticated, phase, posthog]);

  // Monitor server connection for Excalidraw after clicking connect
  useEffect(() => {
    if (phase !== "connecting_excalidraw") return;

    if (excalidrawServer?.connectionStatus === "connected") {
      setPhase("connected_guided");
      setConnectError(null);
      posthog.capture(
        "onboarding_connect_excalidraw_success",
        trackingProps,
      );
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
  }, [onConnect]);

  const completeOnboarding = useCallback(() => {
    persistCompletedState();
    setPhase("completed");
    posthog.capture("onboarding_completed", trackingProps);
  }, [persistCompletedState]);

  const retryConnect = useCallback(() => {
    setPhase("connecting_excalidraw");
    setConnectError(null);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
  }, [onConnect]);

  const isTransitioningToGuided =
    phase === "connecting_excalidraw" && hasConnectedExcalidraw;

  const isOverlayVisible =
    phase === "welcome" ||
    phase === "connect_error" ||
    (phase === "connecting_excalidraw" && !hasConnectedExcalidraw);

  const isGuidedPostConnect =
    phase === "connected_guided" || isTransitioningToGuided;

  return {
    phase,
    isOverlayVisible,
    isGuidedPostConnect,
    isResolvingRemoteCompletion,
    connectExcalidraw,
    completeOnboarding,
    connectError,
    retryConnect,
  };
}
