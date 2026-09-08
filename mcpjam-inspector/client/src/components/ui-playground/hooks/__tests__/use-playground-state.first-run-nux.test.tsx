import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import {
  isFirstRunEligible,
  writeOnboardingState,
} from "@/lib/onboarding-state";
import type { ServerWithName } from "@/state/app-types";

/**
 * The guided first run has two jobs that used to share one localStorage write:
 * retiring the guided copy, and satisfying first-run eligibility so App stops
 * redirecting to the Playground. Marking on paint retired the copy too early
 * (BB-112); not marking at all leaves the redirect armed for the whole run.
 */

const mockState = vi.hoisted(() => ({
  markOnboardingShownMutation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("convex/react", () => ({
  useMutation: () => mockState.markOnboardingShownMutation,
  useQuery: () => undefined,
  useAction: () => vi.fn(),
  useConvex: () => ({}),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: false }),
}));

import { usePlaygroundState } from "../use-playground-state";

function excalidrawServers(
  connectionStatus: ServerWithName["connectionStatus"],
): Record<string, ServerWithName> {
  return {
    [EXCALIDRAW_SERVER_NAME]: {
      name: EXCALIDRAW_SERVER_NAME,
      config: {
        transportType: "http",
        url: "https://example.com/mcp",
      } as ServerWithName["config"],
      lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
      connectionStatus,
      retryCount: 0,
      enabled: true,
    },
  };
}

const connectedExcalidraw = excalidrawServers("connected");

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <SidebarProvider>{children}</SidebarProvider>
    </PreferencesStoreProvider>
  );
}

function renderGuidedFirstRun(isConvexAuthenticated = false) {
  return renderHook(
    ({ authenticated }: { authenticated: boolean }) =>
      usePlaygroundState({
        servers: connectedExcalidraw,
        serverName: EXCALIDRAW_SERVER_NAME,
        serverConfig: connectedExcalidraw[EXCALIDRAW_SERVER_NAME].config,
        isConvexAuthenticated: authenticated,
      }),
    { wrapper, initialProps: { authenticated: isConvexAuthenticated } },
  );
}

describe("usePlaygroundState — first-run NUX lifecycle", () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.markOnboardingShownMutation.mockClear();
    writeOnboardingState({ status: "started", startedAt: Date.now() });
  });

  it("satisfies first-run eligibility once the guided run is on screen", () => {
    const { result } = renderGuidedFirstRun();

    expect(result.current.onboarding.isGuidedPostConnect).toBe(true);
    expect(isFirstRunEligible(false, "servers")).toBe(false);
  });

  it("resumes the guided run after a reload with no message sent", () => {
    const first = renderGuidedFirstRun();
    expect(first.result.current.onboarding.isGuidedPostConnect).toBe(true);
    first.unmount();

    const second = renderGuidedFirstRun();

    expect(second.result.current.onboarding.isGuidedPostConnect).toBe(true);
  });

  it("persists the remote seen flag once Convex auth settles", () => {
    const { rerender } = renderGuidedFirstRun(false);
    expect(mockState.markOnboardingShownMutation).not.toHaveBeenCalled();

    rerender({ authenticated: true });

    expect(mockState.markOnboardingShownMutation).toHaveBeenCalledTimes(1);
  });

  it("stops blocking submit once the guided server is connected", () => {
    const { result } = renderGuidedFirstRun();

    expect(result.current.onboarding.phase).toBe("connected_guided");
    expect(result.current.firstRunSubmitBlocked).toBe(false);
  });
});

describe("usePlaygroundState — first-run servers hydration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  function renderWhileServersLoad() {
    return renderHook(
      ({ areServersHydrated }: { areServersHydrated: boolean }) =>
        usePlaygroundState({
          servers: {},
          onConnect: vi.fn(),
          areServersHydrated,
        }),
      { wrapper, initialProps: { areServersHydrated: false } },
    );
  }

  it("holds the first-run skeleton while the servers map is still loading", () => {
    const { result, rerender } = renderWhileServersLoad();

    // Undecided reads as "dismissed" so the recompute effect can still correct
    // it, but the screen must not fall through to the empty state meanwhile.
    expect(result.current.onboarding.phase).toBe("dismissed");
    expect(result.current.loadingState.kind).toBe("skeleton");

    rerender({ areServersHydrated: true });

    expect(result.current.onboarding.phase).toBe("connecting_excalidraw");
    expect(result.current.loadingState.kind).toBe("skeleton");
  });

  it("does not hold the skeleton for a run that already finished", () => {
    writeOnboardingState({ status: "completed", completedAt: Date.now() });

    const { result } = renderWhileServersLoad();

    expect(result.current.onboarding.phase).toBe("completed");
    expect(result.current.loadingState.kind).not.toBe("skeleton");
  });
});

describe("usePlaygroundState — first-run submit gate", () => {
  beforeEach(() => {
    localStorage.clear();
    writeOnboardingState({ status: "started", startedAt: Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops blocking submit once the first-run skeleton gives up", () => {
    vi.useFakeTimers();
    const connecting = excalidrawServers("connecting");
    const { result } = renderHook(
      () =>
        usePlaygroundState({
          servers: connecting,
          serverName: EXCALIDRAW_SERVER_NAME,
          serverConfig: connecting[EXCALIDRAW_SERVER_NAME].config,
        }),
      { wrapper },
    );

    expect(result.current.onboarding.phase).toBe("connecting_excalidraw");
    expect(result.current.firstRunSubmitBlocked).toBe(true);

    act(() => {
      vi.advanceTimersByTime(12_000);
    });

    expect(result.current.loadingState.kind).not.toBe("skeleton");
    expect(result.current.firstRunSubmitBlocked).toBe(false);
  });
});
