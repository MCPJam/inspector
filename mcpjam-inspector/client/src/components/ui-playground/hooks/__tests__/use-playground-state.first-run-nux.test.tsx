import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import {
  readOnboardingState,
  writeOnboardingState,
} from "@/lib/onboarding-state";
import type { ServerWithName } from "@/state/app-types";

/**
 * The guided first run used to mark itself as seen the moment it painted, and
 * `getInitialLocalPhase` reads a `seen` state back as `dismissed` — so a reload
 * before the first message retired the NUX for good (BB-112).
 */

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
  useAction: () => vi.fn(),
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

import { usePlaygroundState } from "../use-playground-state";

const connectedExcalidraw: Record<string, ServerWithName> = {
  [EXCALIDRAW_SERVER_NAME]: {
    name: EXCALIDRAW_SERVER_NAME,
    config: {
      transportType: "http",
      url: "https://example.com/mcp",
    } as ServerWithName["config"],
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus: "connected",
    retryCount: 0,
    enabled: true,
  },
};

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider>{children}</SidebarProvider>
    </PreferencesStoreProvider>
  );
}

function renderGuidedFirstRun() {
  return renderHook(
    () =>
      usePlaygroundState({
        servers: connectedExcalidraw,
        serverName: EXCALIDRAW_SERVER_NAME,
        serverConfig: connectedExcalidraw[EXCALIDRAW_SERVER_NAME].config,
      }),
    { wrapper },
  );
}

describe("usePlaygroundState — first-run NUX lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    writeOnboardingState({ status: "started", startedAt: Date.now() });
  });

  it("does not mark the NUX as seen while the guided run is on screen", () => {
    const { result } = renderGuidedFirstRun();

    expect(result.current.onboarding.isGuidedPostConnect).toBe(true);
    expect(readOnboardingState()?.status).toBe("started");
  });

  it("resumes the guided run after a reload with no message sent", () => {
    const first = renderGuidedFirstRun();
    expect(first.result.current.onboarding.isGuidedPostConnect).toBe(true);
    first.unmount();

    const second = renderGuidedFirstRun();

    expect(second.result.current.onboarding.isGuidedPostConnect).toBe(true);
  });
});
