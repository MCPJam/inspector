import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
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
): OnboardingPhase {
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
  const convexUser = useQuery(
    "users:getCurrentUser" as any,
    isAuthenticated ? {} : "skip",
  );
  const completeOnboardingMutation = useMutation(
    "users:completeOnboarding" as any,
  );
  const trackingProps = {
    platform: detectPlatform(),
    environment: detectEnvironment(),
  };

  const [phase, setPhase] = useState<OnboardingPhase>(() =>
    getInitialLocalPhase(servers),
  );

  const [connectError, setConnectError] = useState<string | null>(null);
  const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
  const hasConnectedExcalidraw =
    excalidrawServer?.connectionStatus === "connected";
  const isResolvingRemoteCompletion =
    isAuthenticated && (isAuthLoading || convexUser === undefined);
  const hasCompletedOnboardingRemotely =
    convexUser?.hasCompletedOnboarding === true;

  // Track first-run eligible on mount once local and remote completion state
  // have both settled.
  const didTrackFirstRun = useRef(false);
  const didAttemptRemoteBackfill = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      didAttemptRemoteBackfill.current = false;
    }
  }, [isAuthenticated, convexUser?._id]);

  const persistCompletedState = useCallback(() => {
    writeOnboardingState({ status: "completed", completedAt: Date.now() });
    if (isAuthenticated) {
      completeOnboardingMutation().catch(() => {});
    }
  }, [completeOnboardingMutation, isAuthenticated]);

  useEffect(() => {
    if (isResolvingRemoteCompletion) {
      return;
    }

    if (phase === "connected_guided") {
      return;
    }

    if (hasCompletedOnboardingRemotely) {
      setPhase("completed");
      return;
    }

    const persisted = readOnboardingState();
    if (persisted?.status === "completed") {
      setPhase("completed");
    }

    if (!isAuthenticated || didAttemptRemoteBackfill.current) {
      return;
    }

    if (persisted?.status !== "completed" || !convexUser?._id) {
      return;
    }

    didAttemptRemoteBackfill.current = true;
    completeOnboardingMutation().catch(() => {
      didAttemptRemoteBackfill.current = false;
    });
  }, [
    completeOnboardingMutation,
    convexUser?._id,
    hasCompletedOnboardingRemotely,
    isAuthenticated,
    isResolvingRemoteCompletion,
    phase,
  ]);

  useEffect(() => {
    if (
      phase === "welcome" &&
      !didTrackFirstRun.current &&
      !isResolvingRemoteCompletion &&
      !hasCompletedOnboardingRemotely
    ) {
      didTrackFirstRun.current = true;
      writeOnboardingState({ status: "seen" });
      posthog.capture("onboarding_first_run_eligible", trackingProps);
    }
  }, [hasCompletedOnboardingRemotely, isResolvingRemoteCompletion, phase]);

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
