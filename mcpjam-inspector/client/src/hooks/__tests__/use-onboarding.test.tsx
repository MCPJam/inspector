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
  track: vi.fn(),
  convexUser: undefined as
    | {
        _id: string;
        hasSeenOnboarding?: boolean | undefined;
      }
    | null
    | undefined,
  markOnboardingShownMutation: vi.fn().mockResolvedValue(undefined),
  detectEnvironment: vi.fn(() => "test"),
  detectPlatform: vi.fn(() => "web"),
}));

vi.mock("convex/react", () => ({
  useQuery: () => mockState.convexUser,
  useMutation: () => mockState.markOnboardingShownMutation,
}));

vi.mock("@/lib/analytics", () => ({
  track: mockState.track,
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: mockState.detectEnvironment,
  detectPlatform: mockState.detectPlatform,
}));

vi.mock("sonner", () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
  },
}));

function createServer(
  name: string,
  connectionStatus: ServerWithName["connectionStatus"]
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

  it("auto-connects Excalidraw for a fresh first run", async () => {
    const onConnect = vi.fn();
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    expect(result.current.phase).toBe("connecting_excalidraw");

    expect(result.current.isBootstrappingFirstRunConnection).toBe(true);
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("waits for first-run client config sync before auto-connecting", async () => {
    const onConnect = vi.fn();
    const { rerender } = renderHook(
      ({ isClientConfigSyncPending }: { isClientConfigSyncPending: boolean }) =>
        useOnboarding({
          servers: {},
          onConnect,
          isSignedInWithWorkOs: false,
          isWorkOsAuthLoading: false,
          isClientConfigSyncPending,
        }),
      {
        initialProps: {
          isClientConfigSyncPending: true,
        },
      }
    );

    expect(onConnect).not.toHaveBeenCalled();

    rerender({ isClientConfigSyncPending: false });

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("waits for a new guest project before auto-connecting Excalidraw", async () => {
    const onConnect = vi.fn();
    const { rerender } = renderHook(
      ({ isProjectProvisioned }: { isProjectProvisioned: boolean }) =>
        useOnboarding({
          servers: {},
          onConnect,
          isSignedInWithWorkOs: false,
          isWorkOsAuthLoading: false,
          isProjectProvisioned,
        }),
      {
        initialProps: {
          isProjectProvisioned: false,
        },
      }
    );

    expect(onConnect).not.toHaveBeenCalled();

    rerender({ isProjectProvisioned: true });

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("does not show the onboarding overlay while auth is still settling", () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: true,
      })
    );

    expect(result.current.isResolvingRemoteCompletion).toBe(true);
  });

  it("re-derives the guest first-run phase once auth settles", async () => {
    const onConnect = vi.fn();
    const { result, rerender } = renderHook(
      ({ isWorkOsAuthLoading }: { isWorkOsAuthLoading: boolean }) =>
        useOnboarding({
          servers: {},
          onConnect,
          isSignedInWithWorkOs: false,
          isWorkOsAuthLoading,
        }),
      {
        initialProps: {
          isWorkOsAuthLoading: true,
        },
      }
    );

    expect(result.current.phase).toBe("dismissed");

    rerender({ isWorkOsAuthLoading: false });

    await waitFor(() => {
      expect(result.current.phase).toBe("connecting_excalidraw");
    });

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("skips onboarding immediately for signed-in users", async () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isSignedInWithWorkOs: true,
        isWorkOsAuthLoading: false,
      })
    );

    await waitFor(() => {
      expect(result.current.phase).toBe("completed");
    });

    expect(result.current.isResolvingRemoteCompletion).toBe(false);
    expect(readOnboardingState()).toBeNull();
  });

  it("does not use a remote completion loading state for signed-in users", () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isSignedInWithWorkOs: true,
        isWorkOsAuthLoading: false,
      })
    );

    expect(result.current.isResolvingRemoteCompletion).toBe(false);
  });

  it("keeps Excalidraw users in guided mode after connect and resumes until NUX is shown", async () => {
    const onConnect = vi.fn();
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result, rerender, unmount } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useOnboarding({
          servers,
          onConnect,
          isSignedInWithWorkOs: false,
          isWorkOsAuthLoading: false,
        }),
      {
        initialProps: {
          servers: {},
        },
      }
    );

    expect(result.current.phase).toBe("connecting_excalidraw");

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });

    rerender({ servers: connectedServers });

    expect(result.current.isGuidedPostConnect).toBe(true);

    await waitFor(() => {
      expect(result.current.phase).toBe("connected_guided");
    });

    expect(readOnboardingState()).toEqual(
      expect.objectContaining({
        status: "started",
      })
    );

    unmount();

    const resumed = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    expect(resumed.result.current.phase).toBe("connected_guided");
    expect(resumed.result.current.isGuidedPostConnect).toBe(true);
  });

  it("resumes guided mode after the NUX was shown but no message was sent", () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    expect(result.current.phase).toBe("connected_guided");
    expect(result.current.isGuidedPostConnect).toBe(true);
  });

  it("reconnects the guided server on a reload that resumed an unfinished run", async () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const onConnect = vi.fn();

    renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("retires guided mode once the first message completed onboarding", () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "completed", completedAt: Date.now() })
    );
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    expect(result.current.phase).toBe("completed");
    expect(result.current.isGuidedPostConnect).toBe(false);
    expect(result.current.isFirstRunUnfinished).toBe(false);
  });

  it("keeps a resumed run unfinished when the guided server fails to connect", () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const failedServers = {
      [EXCALIDRAW_SERVER_NAME]: {
        ...createServer(EXCALIDRAW_SERVER_NAME, "failed"),
        lastError: "Failed to connect to Excalidraw",
      },
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: failedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    // The guided copy stays withheld — the server never came up — but the run
    // is still this device's to finish, and only a sent message retires it.
    expect(result.current.phase).toBe("connect_error");
    expect(result.current.isGuidedPostConnect).toBe(false);
    expect(result.current.isFirstRunUnfinished).toBe(true);
  });

  it("keeps a resumed run unfinished while the guided connect is still hanging", () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const connectingServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connecting"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectingServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    // A connect that hangs never reaches connect_error, so this phase is where
    // a resumed run sits indefinitely. It is unfinished all the same.
    expect(result.current.phase).toBe("connecting_excalidraw");
    expect(result.current.isGuidedPostConnect).toBe(false);
    expect(result.current.isFirstRunUnfinished).toBe(true);
  });

  it("resumes guided mode when the remote row is seen but this device never finished", () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: true,
      })
    );

    expect(result.current.phase).toBe("connected_guided");
    expect(result.current.isGuidedPostConnect).toBe(true);
  });

  it("keeps guided mode retired for a returning identity with no local first run", () => {
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: true,
      })
    );

    expect(result.current.phase).toBe("dismissed");
    expect(result.current.isGuidedPostConnect).toBe(false);
    expect(result.current.isFirstRunUnfinished).toBe(false);
  });

  it("uses the guest user row over localStorage when deciding first-run eligibility", async () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen", shownAt: Date.now() })
    );
    const onConnect = vi.fn();

    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: false,
      })
    );

    expect(result.current.phase).toBe("connecting_excalidraw");
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("retries first-run auto-connect when the only saved server is an incomplete Excalidraw row", async () => {
    const onConnect = vi.fn();
    const servers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "disconnected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers,
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: false,
      })
    );

    expect(result.current.phase).toBe("connecting_excalidraw");
    expect(result.current.isBootstrappingFirstRunConnection).toBe(false);
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("does not auto-connect first-run Excalidraw when another saved server exists", () => {
    const onConnect = vi.fn();
    const servers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "disconnected"
      ),
      "existing-server": createServer("existing-server", "connected"),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers,
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: false,
      })
    );

    expect(result.current.phase).toBe("dismissed");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("skips guest first-run onboarding when the guest user row was already marked shown", () => {
    const onConnect = vi.fn();

    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: true,
      })
    );

    expect(result.current.phase).toBe("dismissed");
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("marks remote onboarding as shown without ending the current guided flow", async () => {
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result } = renderHook(() =>
      useOnboarding({
        servers: connectedServers,
        onConnect: vi.fn(),
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
        hasRemoteOnboardingState: true,
        hasSeenOnboarding: false,
        canPersistRemoteOnboarding: true,
      })
    );

    expect(result.current.phase).toBe("connected_guided");

    act(() => {
      result.current.markOnboardingShown();
    });

    await waitFor(() => {
      expect(mockState.markOnboardingShownMutation).toHaveBeenCalledTimes(1);
    });
    expect(result.current.phase).toBe("connected_guided");
    expect(readOnboardingState()).toEqual(
      expect.objectContaining({
        status: "seen",
      })
    );
  });

  it("retries auto-connect when App Builder is mounted with legacy seen state but no servers", async () => {
    localStorage.setItem(
      "mcp-onboarding-state",
      JSON.stringify({ status: "seen" })
    );

    const onConnect = vi.fn();
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect,
        isSignedInWithWorkOs: false,
        isWorkOsAuthLoading: false,
      })
    );

    expect(result.current.phase).toBe("connecting_excalidraw");
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });
  });

  it("does not call the Convex shown mutation when Excalidraw connects", async () => {
    const onConnect = vi.fn();
    const connectedServers = {
      [EXCALIDRAW_SERVER_NAME]: createServer(
        EXCALIDRAW_SERVER_NAME,
        "connected"
      ),
    };

    const { result, rerender } = renderHook(
      ({ servers }: { servers: Record<string, ServerWithName> }) =>
        useOnboarding({
          servers,
          onConnect,
          isSignedInWithWorkOs: false,
          isWorkOsAuthLoading: false,
        }),
      {
        initialProps: {
          servers: {},
        },
      }
    );

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(EXCALIDRAW_SERVER_CONFIG);
    });

    rerender({ servers: connectedServers });

    await waitFor(() => {
      expect(result.current.phase).toBe("connected_guided");
    });

    expect(mockState.markOnboardingShownMutation).not.toHaveBeenCalled();
  });

  it("keeps completion local when completeOnboarding is called", async () => {
    const { result } = renderHook(() =>
      useOnboarding({
        servers: {},
        onConnect: vi.fn(),
        isSignedInWithWorkOs: true,
        isWorkOsAuthLoading: false,
        canPersistRemoteOnboarding: true,
      })
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
      })
    );
    expect(mockState.markOnboardingShownMutation).not.toHaveBeenCalled();
  });
});
