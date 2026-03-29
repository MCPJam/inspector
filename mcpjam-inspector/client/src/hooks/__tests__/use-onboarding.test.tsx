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

  it("skips onboarding for signed-in users whose Convex user is already completed", async () => {
    mockState.convexUser = {
      _id: "user-1",
      hasCompletedOnboarding: true,
    };

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

  it("keeps showing the remote-completion loading state while the signed-in user query is unresolved", () => {
    mockState.convexUser = undefined;

    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isAuthenticated: true,
        isAuthLoading: false,
      }),
    );

    expect(result.current.isResolvingRemoteCompletion).toBe(true);
  });

  it("backfills Convex completion for signed-in users with legacy local completion", async () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: 123 }),
    );
    mockState.convexUser = {
      _id: "user-1",
      hasCompletedOnboarding: undefined,
    };

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

    expect(mockState.completeOnboardingMutation).toHaveBeenCalledTimes(1);
  });

  it("waits for the Convex user row before backfilling legacy local completion", async () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: 123 }),
    );
    mockState.convexUser = null;

    const { result, rerender } = renderHook(() =>
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

    expect(mockState.completeOnboardingMutation).not.toHaveBeenCalled();

    mockState.convexUser = {
      _id: "user-1",
      hasCompletedOnboarding: undefined,
    };

    rerender();

    await waitFor(() => {
      expect(mockState.completeOnboardingMutation).toHaveBeenCalledTimes(1);
    });
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
      ({
        servers,
      }: {
        servers: Record<string, ServerWithName>;
      }) =>
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
    mockState.convexUser = {
      _id: "user-1",
      hasCompletedOnboarding: undefined,
    };

    const onConnect = vi.fn();
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected",
      ),
    };

    const { result, rerender } = renderHook(
      ({
        servers,
      }: {
        servers: Record<string, ServerWithName>;
      }) =>
        useOnboarding({
          servers,
          onConnect,
          isAuthenticated: true,
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
    mockState.convexUser = {
      _id: "user-1",
      hasCompletedOnboarding: undefined,
    };

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
