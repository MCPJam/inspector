import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useMutation } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { toast } from "@/lib/toast";
import type { OnboardingPhase } from "@/lib/onboarding-state";
import {
  markOnboardingShown,
  markOnboardingStarted,
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
  isSignedInWithWorkOs: boolean;
  isWorkOsAuthLoading: boolean;
  hasRemoteOnboardingState?: boolean;
  hasSeenOnboarding?: boolean;
  canPersistRemoteOnboarding?: boolean;
  isProjectProvisioned?: boolean;
}

interface UseOnboardingReturn {
  phase: OnboardingPhase;
  isGuidedPostConnect: boolean;
  isResolvingRemoteCompletion: boolean;
  /** True before the Excalidraw server row exists (auto-connect not yet dispatched). */
  isBootstrappingFirstRunConnection: boolean;
  connectExcalidraw: () => void;
  markOnboardingShown: () => void;
  completeOnboarding: () => void;
  connectError: string | null;
  retryConnect: () => void;
}

function getInitialLocalPhase(
  servers: Record<string, ServerWithName>,
  {
    isSignedInWithWorkOs,
    isWorkOsAuthLoading,
    hasRemoteOnboardingState = false,
    hasSeenOnboarding = false,
  }: Pick<
    UseOnboardingOptions,
    | "isSignedInWithWorkOs"
    | "isWorkOsAuthLoading"
    | "hasRemoteOnboardingState"
    | "hasSeenOnboarding"
  >,
): OnboardingPhase {
  if (isWorkOsAuthLoading) return "dismissed";
  if (isSignedInWithWorkOs) return "completed";
  if (hasRemoteOnboardingState && hasSeenOnboarding) return "dismissed";

  const persisted = hasRemoteOnboardingState ? null : readOnboardingState();
  if (!hasRemoteOnboardingState) {
    if (persisted?.status === "completed") return "completed";
    if (persisted?.status === "dismissed") return "dismissed";
    if (persisted?.status === "seen" && persisted.shownAt) return "dismissed";
  }

  const serverEntries = Object.entries(servers);
  const hasAnyServers = serverEntries.length > 0;
  const hasOnlyExcalidrawServer =
    serverEntries.length === 1 &&
    serverEntries[0]?.[0] === EXCALIDRAW_SERVER_NAME;
  const shouldContinueFirstRun =
    (hasRemoteOnboardingState && !hasSeenOnboarding) ||
    persisted?.status === "started" ||
    (persisted?.status === "seen" && !persisted.shownAt);

  if (!hasAnyServers) {
    return "connecting_excalidraw";
  }
  const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
  if (shouldContinueFirstRun) {
    if (excalidrawServer?.connectionStatus === "connected") {
      return "connected_guided";
    }
    if (hasOnlyExcalidrawServer) {
      return "connecting_excalidraw";
    }
  }

  return "dismissed";
}

export function useOnboarding({
  servers,
  onConnect,
  isSignedInWithWorkOs,
  isWorkOsAuthLoading,
  hasRemoteOnboardingState = false,
  hasSeenOnboarding = false,
  canPersistRemoteOnboarding = false,
  isProjectProvisioned = true,
}: UseOnboardingOptions): UseOnboardingReturn {
  const posthog = usePostHog();
  const markOnboardingAsShownMutation = useMutation(
    "users:markOnboardingShown" as any,
  );
  const trackingProps = useMemo(
    () => ({
      platform: detectPlatform(),
      environment: detectEnvironment(),
    }),
    [],
  );

  const [phase, setPhase] = useState<OnboardingPhase>(() =>
    getInitialLocalPhase(servers, {
      isSignedInWithWorkOs,
      isWorkOsAuthLoading,
      hasRemoteOnboardingState,
      hasSeenOnboarding,
    }),
  );

  const [connectError, setConnectError] = useState<string | null>(null);
  const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
  const hasConnectedExcalidraw =
    excalidrawServer?.connectionStatus === "connected";
  const isResolvingRemoteCompletion = isWorkOsAuthLoading;

  const didAutoConnectRef = useRef(false);
  const didPersistRemoteShownRef = useRef(false);

  // Track first-run eligible once when auto-connect begins.
  const didTrackFirstRun = useRef(false);

  const persistRemoteOnboardingShown = useCallback(() => {
    if (
      !canPersistRemoteOnboarding ||
      hasSeenOnboarding ||
      didPersistRemoteShownRef.current
    ) {
      return;
    }
    didPersistRemoteShownRef.current = true;
    markOnboardingAsShownMutation().catch(() => {
      didPersistRemoteShownRef.current = false;
    });
  }, [
    canPersistRemoteOnboarding,
    hasSeenOnboarding,
    markOnboardingAsShownMutation,
  ]);

  const markFirstRunOnboardingShown = useCallback(() => {
    markOnboardingShown();
    persistRemoteOnboardingShown();
  }, [persistRemoteOnboardingShown]);

  const persistCompletedState = useCallback(() => {
    writeOnboardingState({ status: "completed", completedAt: Date.now() });
  }, []);

  useEffect(() => {
    if (isWorkOsAuthLoading) {
      return;
    }

    if (isSignedInWithWorkOs) {
      setPhase("completed");
      return;
    }

    setPhase((currentPhase) => {
      if (currentPhase !== "dismissed") {
        return currentPhase;
      }

      return getInitialLocalPhase(servers, {
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState,
        hasSeenOnboarding,
      });
    });
  }, [
    servers,
    isWorkOsAuthLoading,
    isSignedInWithWorkOs,
    hasRemoteOnboardingState,
    hasSeenOnboarding,
  ]);

  // First-run guests: auto-connect Excalidraw in the background (no welcome overlay).
  useEffect(() => {
    if (isWorkOsAuthLoading || isSignedInWithWorkOs) return;
    if (didAutoConnectRef.current) return;
    if (!isProjectProvisioned) return;

    if (hasRemoteOnboardingState) {
      if (hasSeenOnboarding) return;
    } else {
      const persisted = readOnboardingState();
      if (
        persisted?.status === "completed" ||
        persisted?.status === "dismissed" ||
        (persisted?.status === "seen" && persisted.shownAt)
      ) {
        return;
      }
    }
    const hasBlockingServer = Object.keys(servers).some(
      (serverName) => serverName !== EXCALIDRAW_SERVER_NAME,
    );
    if (hasBlockingServer) return;
    const excalidrawStatus = servers[EXCALIDRAW_SERVER_NAME]?.connectionStatus;
    if (excalidrawStatus === "connected" || excalidrawStatus === "connecting") {
      return;
    }
    if (phase !== "connecting_excalidraw") return;

    didAutoConnectRef.current = true;
    if (!didTrackFirstRun.current) {
      didTrackFirstRun.current = true;
      markOnboardingStarted();
      posthog.capture("onboarding_first_run_eligible", trackingProps);
    }
    setConnectError(null);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
    posthog.capture("onboarding_connect_excalidraw_auto", trackingProps);
  }, [
    phase,
    servers,
    isWorkOsAuthLoading,
    isSignedInWithWorkOs,
    isProjectProvisioned,
    hasRemoteOnboardingState,
    hasSeenOnboarding,
    onConnect,
    posthog,
    trackingProps,
  ]);

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
    markOnboardingShown: markFirstRunOnboardingShown,
    completeOnboarding,
    connectError,
    retryConnect,
  };
}
