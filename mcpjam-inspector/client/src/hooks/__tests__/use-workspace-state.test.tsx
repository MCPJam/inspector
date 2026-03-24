import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppAction, AppState, Workspace } from "@/state/app-types";
import { useWorkspaceState } from "../use-workspace-state";

const {
  createWorkspaceMock,
  ensureDefaultWorkspaceMock,
  updateWorkspaceMock,
  deleteWorkspaceMock,
  workspaceQueryState,
  serializeServersForSharingMock,
} = vi.hoisted(() => ({
  createWorkspaceMock: vi.fn(),
  ensureDefaultWorkspaceMock: vi.fn(),
  updateWorkspaceMock: vi.fn(),
  deleteWorkspaceMock: vi.fn(),
  workspaceQueryState: {
    allWorkspaces: undefined as any,
    workspaces: undefined as any,
    isLoading: false,
  },
  serializeServersForSharingMock: vi.fn((servers) => servers),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../useWorkspaces", () => ({
  useWorkspaceQueries: () => workspaceQueryState,
  useWorkspaceMutations: () => ({
    createWorkspace: createWorkspaceMock,
    ensureDefaultWorkspace: ensureDefaultWorkspaceMock,
    updateWorkspace: updateWorkspaceMock,
    deleteWorkspace: deleteWorkspaceMock,
  }),
  useWorkspaceServers: () => ({
    servers: undefined,
    isLoading: false,
  }),
}));

vi.mock("@/lib/workspace-serialization", () => ({
  deserializeServersFromConvex: vi.fn((servers) => servers ?? {}),
  serializeServersForSharing: serializeServersForSharingMock,
}));

function createSyntheticDefaultWorkspace(): Workspace {
  return {
    id: "default",
    name: "Default",
    description: "Default workspace",
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    isDefault: true,
  };
}

function createLocalWorkspace(
  id: string,
  overrides: Partial<Workspace> = {},
): Workspace {
  return {
    id,
    name: `Workspace ${id}`,
    servers: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createAppState(workspaces: Record<string, Workspace>): AppState {
  const firstWorkspaceId = Object.keys(workspaces)[0] ?? "none";
  return {
    workspaces,
    activeWorkspaceId: firstWorkspaceId,
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  };
}

function renderUseWorkspaceState({
  appState,
  activeOrganizationId,
}: {
  appState: AppState;
  activeOrganizationId?: string;
}) {
  const dispatch = vi.fn<(action: AppAction) => void>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const result = renderHook(
    ({ organizationId }: { organizationId?: string }) =>
      useWorkspaceState({
        appState,
        dispatch,
        isAuthenticated: true,
        isAuthLoading: false,
        activeOrganizationId: organizationId,
        logger,
      }),
    {
      initialProps: {
        organizationId: activeOrganizationId,
      },
    },
  );

  return {
    ...result,
    dispatch,
    logger,
  };
}

describe("useWorkspaceState automatic workspace creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    createWorkspaceMock.mockResolvedValue("remote-workspace-id");
    ensureDefaultWorkspaceMock.mockResolvedValue("default-workspace-id");
    updateWorkspaceMock.mockResolvedValue("remote-workspace-id");
    deleteWorkspaceMock.mockResolvedValue(undefined);
    workspaceQueryState.allWorkspaces = [];
    workspaceQueryState.workspaces = [];
    workspaceQueryState.isLoading = false;
  });

  it("ensures one initial workspace per empty organization and dedupes rerenders", async () => {
    workspaceQueryState.allWorkspaces = [
      {
        _id: "remote-1",
        name: "Existing workspace",
        servers: {},
        ownerId: "user-1",
        organizationId: "org-a",
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    workspaceQueryState.workspaces = [];

    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-b",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
      organizationId: "org-b",
    });
    expect(createWorkspaceMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-b" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    rerender({ organizationId: "org-c" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(2);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenLastCalledWith({
      organizationId: "org-c",
    });
  });

  it("migrates real local workspaces with createWorkspace and persists the shared workspace id", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
      "local-1": createLocalWorkspace("local-1", {
        name: "Imported workspace",
        description: "Needs migration",
        servers: {
          demo: {
            name: "demo",
            config: { url: "https://example.com/mcp" } as any,
            lastConnectionTime: new Date("2026-01-01T00:00:00.000Z"),
            connectionStatus: "disconnected",
            retryCount: 0,
          },
        },
      }),
    });

    const { dispatch } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-migrate",
    });

    await waitFor(() => {
      expect(createWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(serializeServersForSharingMock).toHaveBeenCalledWith(
      appState.workspaces["local-1"].servers,
    );
    expect(createWorkspaceMock).toHaveBeenCalledWith({
      organizationId: "org-migrate",
      name: "Imported workspace",
      description: "Needs migration",
      servers: appState.workspaces["local-1"].servers,
    });
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "UPDATE_WORKSPACE",
        workspaceId: "local-1",
        updates: {
          sharedWorkspaceId: "remote-workspace-id",
          organizationId: "org-migrate",
        },
      });
    });
    expect(ensureDefaultWorkspaceMock).not.toHaveBeenCalled();
  });

  it("treats the empty synthetic default as ensure-default only, not a migration candidate", async () => {
    const appState = createAppState({
      default: createSyntheticDefaultWorkspace(),
    });
    const { rerender } = renderUseWorkspaceState({
      appState,
      activeOrganizationId: "org-empty",
    });

    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });

    expect(ensureDefaultWorkspaceMock).toHaveBeenCalledWith({
      organizationId: "org-empty",
    });
    expect(serializeServersForSharingMock).not.toHaveBeenCalled();
    expect(createWorkspaceMock).not.toHaveBeenCalled();

    rerender({ organizationId: "org-empty" });
    await waitFor(() => {
      expect(ensureDefaultWorkspaceMock).toHaveBeenCalledTimes(1);
    });
  });
});
