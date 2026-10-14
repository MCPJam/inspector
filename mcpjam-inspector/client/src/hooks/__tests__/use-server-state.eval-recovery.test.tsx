import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useServerState } from "../use-server-state";
import {
  createHttpServerConfig,
  createProject,
  createServer,
} from "@/test/factories";
import type { AppState } from "@/state/app-types";

const { reconnect, authorize } = vi.hoisted(() => ({
  reconnect: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("convex/react", () => ({ useConvex: () => ({ query: vi.fn() }) }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(),
  listServers: vi.fn(),
  reconnectServer: reconnect,
  getInitializationInfo: vi.fn(),
}));
vi.mock("@/state/oauth-orchestrator", () => ({
  ensureAuthorizedForReconnect: authorize,
}));
vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
  tryGetHostedServerDisplayName: () => "excalidraw",
  tryResolveProjectServer: () => ({ projectId: "project", serverId: "server" }),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));
vi.mock("../useProjects", () => ({
  useServerMutations: () => ({
    createServer: vi.fn(),
    createServerIfMissing: vi.fn(),
    updateServer: vi.fn(),
    deleteServer: vi.fn(),
  }),
}));

function renderConnectedServer() {
  const server = createServer({
    name: "excalidraw",
    config: createHttpServerConfig("https://example.com/mcp"),
    useOAuth: true,
    connectionStatus: "connected",
  });
  const project = createProject({
    id: "project",
    sharedProjectId: "project",
    servers: { excalidraw: server },
  });
  const appState: AppState = {
    activeProjectId: "project",
    projects: { project },
    servers: { excalidraw: server },
    selectedServer: "excalidraw",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
  return renderHook(() =>
    useServerState({
      appState,
      dispatch: vi.fn(),
      isLoading: false,
      isAuthenticated: true,
      hasSignedInUser: false,
      isAuthLoading: false,
      isLoadingProjects: false,
      useLocalFallback: false,
      effectiveProjects: appState.projects,
      effectiveActiveProjectId: "project",
      activeProjectServersFlat: [],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  reconnect.mockReset().mockResolvedValue({
    success: false,
    error:
      'Server "excalidraw" requires OAuth authentication. Please complete the OAuth flow first.',
    oauthRequired: true,
  });
  authorize
    .mockReset()
    .mockImplementation((_server, options) =>
      Promise.resolve(
        options.allowInteractiveOAuthFlow
          ? { kind: "redirect" }
          : {
              kind: "reauth_required",
              error: "Reauthenticate excalidraw to continue.",
            },
      ),
    );
});

it("reauthorizes a stale connected server when Evaluate explicitly requests recovery", async () => {
  const { result } = renderConnectedServer();
  await act(async () => {
    const readiness = await result.current.ensureServersReady(["excalidraw"], {
      allowInteractiveOAuthFlow: true,
      forceReconnect: true,
    });
    expect(readiness.reauthServerNames).toEqual(["excalidraw"]);
  });
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ name: "excalidraw" }),
    expect.objectContaining({ allowInteractiveOAuthFlow: true }),
  );
});

it("still skips connected servers for ordinary background readiness checks", async () => {
  const { result } = renderConnectedServer();
  await act(async () => {
    const readiness = await result.current.ensureServersReady(["excalidraw"]);
    expect(readiness.readyServerNames).toEqual(["excalidraw"]);
  });
  expect(reconnect).not.toHaveBeenCalled();
  expect(authorize).not.toHaveBeenCalled();
});

it("reports ready after a forced reconnect succeeds without requiring OAuth", async () => {
  reconnect.mockResolvedValue({ success: true });
  const { result } = renderConnectedServer();
  await act(async () => {
    const readiness = await result.current.ensureServersReady(["excalidraw"], {
      allowInteractiveOAuthFlow: true,
      forceReconnect: true,
    });
    expect(readiness.readyServerNames).toEqual(["excalidraw"]);
  });
  expect(reconnect).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});
