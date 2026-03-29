import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerWithName } from "@/state/app-types";
import { readOnboardingState } from "@/lib/onboarding-state";
import {
  EXCALIDRAW_SERVER_CONFIG,
  EXCALIDRAW_SERVER_NAME,
} from "@/lib/excalidraw-quick-connect";
import { useOnboarding } from "../use-onboarding";

const mockState = vi.hoisted(() => ({
  posthog: {
    capture: vi.fn(),
  },
  convexUser: undefined as
    | { _id: string; hasCompletedOnboarding?: boolean | undefined }
    | null
    | undefined,
  completeOnboardingMutation: vi.fn().mockResolvedValue(undefined),
  detectEnvironment: vi.fn(() => "test"),
  detectPlatform: vi.fn(() => "web"),
}));

vi.mock("convex/react", () => ({
  useQuery: () => mockState.convexUser,
  useMutation: () => mockState.completeOnboardingMutation,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => mockState.posthog,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: mockState.detectEnvironment,
  detectPlatform: mockState.detectPlatform,
}));

function createServer(
  name: string,
  connectionStatus: ServerWithName["connectionStatus"],
): ServerWithName {
  return {
    name,
    config: {
      transportType: "http",
      url: "https://example.com/mcp",
    } as any,
    lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
    connectionStatus,
    retryCount: 0,
    enabled: true,
  };
}

describe("useOnboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockState.convexUser = undefined;
  });

  it("shows the welcome phase for a fresh first run", () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: false,
        isAuthLoading: false,
      }),
    );

    expect(result.current.phase).toBe("welcome");
    expect(result.current.isOverlayVisible).toBe(true);
  });

  it("does not show the onboarding overlay while auth is still settling", () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: false,
        isAuthLoading: true,
      }),
    );

    expect(result.current.isResolvingRemoteCompletion).toBe(true);
    expect(result.current.isOverlayVisible).toBe(false);
  });

  it("re-derives the guest welcome phase once auth settles", () => {
    const { result, rerender } = renderHook(
      ({ isAuthLoading }: { isAuthLoading: boolean }) =>
        useOnboarding({
          servers: {},
          onConnect: vi.fn(),
          isAuthenticated: false,
          isAuthLoading,
        }),
      {
        initialProps: {
          isAuthLoading: true,
        },
      },
    );

    expect(result.current.phase).toBe("dismissed");
    expect(result.current.isOverlayVisible).toBe(false);

    rerender({ isAuthLoading: false });

    expect(result.current.phase).toBe("welcome");
    expect(result.current.isOverlayVisible).toBe(true);
  });

  it("skips onboarding immediately for signed-in users", async () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: true,
        isAuthLoading: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.phase).toBe("completed");
    });

    expect(result.current.isOverlayVisible).toBe(false);
    expect(result.current.isResolvingRemoteCompletion).toBe(false);
    expect(readOnboardingState()).toBeNull();
  });

  it("does not use a remote completion loading state for signed-in users", () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: true,
        isAuthLoading: false,
      }),
    );

    expect(result.current.isResolvingRemoteCompletion).toBe(false);
  });

  it("keeps Excalidraw users in guided mode after connect without persisting completion, and does not resume guided mode on remount", async () => {
    const onConnect = vi.fn();
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected",
      ),
    };

    const { result, rerender, unmount } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useOnboarding({
          servers,
          onConnect,
          isAuthenticated: false,
          isAuthLoading: false,
        }),
      {
        initialProps: {
          servers: {},
        },
      },
    );

    expect(result.current.phase).toBe("welcome");

    act(() => {
      result.current.connectExcalidraw();
    });

    expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);

    rerender({ servers: connectedServers });

    expect(result.current.isGuidedPostConnect).toBe(true);
    expect(result.current.isOverlayVisible).toBe(false);

    await waitFor(() => {
      expect(result.current.phase).toBe("connected_guided");
    });

    expect(readOnboardingState()).toEqual(
      expect.objectContaining({
        status: "seen",
      }),
    );

    unmount();

    const resumed = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect,
        isAuthenticated: false,
        isAuthLoading: false,
      }),
    );

    expect(resumed.result.current.phase).toBe("dismissed");
    expect(resumed.result.current.isGuidedPostConnect).toBe(false);
  });

  it("does not call the Convex completion mutation when Excalidraw connects", async () => {
    const onConnect = vi.fn();
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected",
      ),
    };

    const { result, rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useOnboarding({
          servers,
          onConnect,
          isAuthenticated: false,
          isAuthLoading: false,
        }),
      {
        initialProps: {
          servers: {},
        },
      },
    );

    act(() => {
      result.current.connectExcalidraw();
    });

    rerender({ servers: connectedServers });

    await waitFor(() => {
      expect(result.current.phase).toBe("connected_guided");
    });

    expect(mockState.completeOnboardingMutation).not.toHaveBeenCalled();
  });

  it("persists onboarding completion only when completeOnboarding is called", async () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: true,
        isAuthLoading: false,
      }),
    );

    act(() => {
      result.current.completeOnboarding();
    });

    await waitFor(() => {
      expect(result.current.phase).toBe("completed");
    });

    expect(readOnboardingState()).toEqual(
      expect.objectContaining({
        status: "completed",
      }),
    );
    expect(mockState.completeOnboardingMutation).toHaveBeenCalledTimes(1);
  });
});
