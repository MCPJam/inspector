import { useState, useCallback, useEffect, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import type { OnboardingPhase } from "@/lib/onboarding-state";
import {
  isFirstRunEligible,
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
  registryEnabled: boolean;
  onNavigate: (section: string) => void;
  onConnect: (formData: ServerFormData) => void;
}

interface UseOnboardingReturn {
  phase: OnboardingPhase;
  isOverlayVisible: boolean;
  isGuidedPostConnect: boolean;
  connectExcalidraw: () => void;
  browseRegistry: () => void;
  openManualModal: () => void;
  closeManualModal: () => void;
  dismissOverlay: () => void;
  completeOnboarding: () => void;
  connectError: string | null;
  retryConnect: () => void;
}

export function useOnboarding({
  servers,
  registryEnabled,
  onNavigate,
  onConnect,
}: UseOnboardingOptions): UseOnboardingReturn {
  const posthog = usePostHog();
  const trackingProps = {
    platform: detectPlatform(),
    environment: detectEnvironment(),
  };

  // Determine initial phase from localStorage + eligibility
  // Note: by the time this hook runs, App.tsx may have already changed the hash
  // to #app-builder, so we don't re-check the hash here. We only check:
  // - no connected servers
  // - no completed/dismissed onboarding state in localStorage
  const [phase, setPhase] = useState<OnboardingPhase>(() => {
    const persisted = readOnboardingState();
    if (persisted?.status === "completed") return "completed";
    if (persisted?.status === "dismissed") return "dismissed";

    // If status is "seen" (started but not finished) or null (never started),
    // and no servers are connected, show the welcome overlay
    const hasConnected = Object.values(servers).some(
      (s) => s.connectionStatus === "connected",
    );
    if (!hasConnected && !persisted) {
      return "welcome";
    }

    return "dismissed";
  });

  const [connectError, setConnectError] = useState<string | null>(null);

  // Track first-run eligible on mount
  const didTrackFirstRun = useRef(false);
  useEffect(() => {
    if (phase === "welcome" && !didTrackFirstRun.current) {
      didTrackFirstRun.current = true;
      writeOnboardingState({ status: "seen" });
      posthog.capture("onboarding_first_run_eligible", trackingProps);
    }
  }, [phase]);

  // Monitor server connection for Excalidraw after clicking connect
  useEffect(() => {
    if (phase !== "connecting_excalidraw") return;

    const excalidrawServer = servers[EXCALIDRAW_SERVER_NAME];
    if (excalidrawServer?.connectionStatus === "connected") {
      writeOnboardingState({ status: "completed", completedAt: Date.now() });
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
  }, [phase, servers]);

  // Also handle manual_modal_open: if any server connects, complete onboarding
  useEffect(() => {
    if (phase !== "manual_modal_open") return;

    const hasConnected = Object.values(servers).some(
      (s) => s.connectionStatus === "connected",
    );
    if (hasConnected) {
      writeOnboardingState({ status: "completed", completedAt: Date.now() });
      setPhase("completed");
    }
  }, [phase, servers]);

  const connectExcalidraw = useCallback(() => {
    setPhase("connecting_excalidraw");
    setConnectError(null);
    posthog.capture("onboarding_connect_excalidraw_clicked", trackingProps);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
  }, [onConnect]);

  const browseRegistry = useCallback(() => {
    writeOnboardingState({ status: "dismissed" });
    setPhase("dismissed");
    posthog.capture("onboarding_browse_registry_clicked", trackingProps);
    onNavigate("registry");
  }, [onNavigate]);

  const openManualModal = useCallback(() => {
    setPhase("manual_modal_open");
    posthog.capture("onboarding_add_server_manual_clicked", trackingProps);
  }, []);

  const closeManualModal = useCallback(() => {
    setPhase("welcome");
  }, []);

  const dismissOverlay = useCallback(() => {
    writeOnboardingState({ status: "dismissed" });
    setPhase("dismissed");
    posthog.capture("onboarding_dismissed", trackingProps);
  }, []);

  const completeOnboarding = useCallback(() => {
    writeOnboardingState({ status: "completed", completedAt: Date.now() });
    setPhase("completed");
    posthog.capture("onboarding_completed", trackingProps);
  }, []);

  const retryConnect = useCallback(() => {
    setPhase("connecting_excalidraw");
    setConnectError(null);
    onConnect(EXCALIDRAW_SERVER_CONFIG);
  }, [onConnect]);

  const isOverlayVisible =
    phase === "welcome" ||
    phase === "connecting_excalidraw" ||
    phase === "connect_error";

  const isGuidedPostConnect = phase === "connected_guided";

  return {
    phase,
    isOverlayVisible,
    isGuidedPostConnect,
    connectExcalidraw,
    browseRegistry,
    openManualModal,
    closeManualModal,
    dismissOverlay,
    completeOnboarding,
    connectError,
    retryConnect,
  };
}
