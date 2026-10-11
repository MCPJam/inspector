import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { errorToastMessage } from "@/test/utils";
import { createProject, createServer } from "@/test/factories";
import { createInitialAppState } from "@/state/app-types";
import { useServerState } from "../use-server-state";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  create: vi.fn(async () => "server-new"),
  clear: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: mocks.error } }));
vi.mock("convex/react", () => ({ useConvex: () => ({ query: vi.fn() }) }));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
vi.mock("@/state/mcp-api", () => ({
  testConnection: vi.fn(),
  deleteServer: vi.fn(async () => ({ success: true })),
  listServers: vi.fn(async () => ({ success: true, servers: [] })),
  reconnectServer: vi.fn(),
  getInitializationInfo: vi.fn(),
}));
vi.mock("../useProjects", () => ({
  useServerMutations: () => ({
    createServer: vi.fn(),
    createServerIfMissing: mocks.create,
    updateServer: vi.fn(),
    updateServerWithClientSecret: vi.fn(),
    createServerWithClientSecret: vi.fn(),
    deleteServer: mocks.remove,
  }),
}));
vi.mock("@/lib/oauth/mcp-oauth", async (original) => ({
  ...(await original<typeof import("@/lib/oauth/mcp-oauth")>()),
  clearOAuthData: mocks.clear,
  getStoredTokens: vi.fn(),
}));
vi.mock("@/lib/apis/web/context", () => ({
  injectHostedServerMapping: vi.fn(),
  tryGetHostedServerDisplayName: vi.fn(),
  tryResolveProjectServer: () => ({
    projectId: "project-a",
    serverId: "server-a",
  }),
}));
vi.mock("@/lib/session-token", () => ({ authFetch: vi.fn() }));

function setup(withCloudRow = true) {
  const server = createServer({ name: "demo", useOAuth: false });
  const project = createProject({
    id: "project-a",
    sharedProjectId: "project-a",
    servers: { demo: server },
  });
  const dispatch = vi.fn();
  const { result } = renderHook(() =>
    useServerState({
      appState: {
        ...createInitialAppState(),
        activeProjectId: project.id,
        projects: { [project.id]: project },
        servers: project.servers,
      },
      dispatch,
      isLoading: false,
      isAuthenticated: true,
      hasSignedInUser: true,
      currentUserId: "person-a",
      isAuthLoading: false,
      isLoadingProjects: false,
      useLocalFallback: false,
      effectiveProjects: { [project.id]: project },
      effectiveActiveProjectId: project.id,
      activeProjectServersFlat: withCloudRow
        ? [{ _id: "server-a", name: "demo" }]
        : undefined,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }),
  );
  return { result, dispatch };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it.each([
  { accepted: true, deleted: false, requestId: "receipt-a", state: "accepted" },
  { deleted: true },
])(
  "removes local state only after cloud acknowledgment and returns the actual result",
  async (receipt) => {
    let acknowledge: (value: typeof receipt) => void = () => {};
    mocks.remove.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { result, dispatch } = setup();
    let pending: Promise<unknown> | undefined;
    await act(async () => {
      pending = result.current.handleRemoveServer("demo");
    });
    expect(mocks.remove).toHaveBeenCalledWith({ serverId: "server-a" });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "REMOVE_SERVER",
      name: "demo",
    });
    await act(async () => {
      acknowledge(receipt);
      expect(await pending).toEqual(receipt);
    });
    expect(mocks.clear).toHaveBeenCalledWith("demo");
    expect(dispatch).toHaveBeenCalledWith({
      type: "REMOVE_SERVER",
      name: "demo",
    });
  },
);

it.each(["DELETION_PROTOCOL_REQUIRED", "Failed to fetch"])(
  "surfaces %s and retains local server and OAuth data",
  async (message) => {
    const refusal = new Error(message);
    mocks.remove.mockRejectedValueOnce(refusal);
    const { result, dispatch } = setup();
    await act(async () => {
      await expect(result.current.handleRemoveServer("demo")).rejects.toBe(
        refusal,
      );
    });
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith({
      type: "REMOVE_SERVER",
      name: "demo",
    });
    expect(mocks.error).toHaveBeenCalledWith(
      errorToastMessage(
        "Could not confirm server removal. Refresh before retrying.",
      ),
      { duration: 8000 },
    );
  },
);

it("keeps explicit local-only removal available without submitting cloud deletion", async () => {
  const { result, dispatch } = setup();
  await act(async () => {
    await result.current.handleRemoveServer("demo", { removeFromCloud: false });
  });
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith({
    type: "REMOVE_SERVER",
    name: "demo",
  });
});

it("preserves local rename bookkeeping after a successful cloud upsert without deleting another row", async () => {
  const { result, dispatch } = setup(false);
  await act(async () => {
    expect(
      await result.current.saveServerConfigWithoutConnecting(
        {
          name: "renamed",
          type: "http",
          url: "https://example.test/mcp",
        },
        { originalServerName: "demo" },
      ),
    ).toBe(true);
  });
  expect(mocks.create).toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledWith({
    type: "REMOVE_SERVER",
    name: "demo",
  });
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "UPSERT_SERVER", name: "renamed" }),
  );
});

it("refuses an explicit cloud deletion while its row lookup is unavailable", async () => {
  const { result, dispatch } = setup(false);
  await act(async () => {
    await expect(result.current.handleRemoveServer("demo")).rejects.toThrow(
      "Server not found in cloud",
    );
  });
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalledWith({
    type: "REMOVE_SERVER",
    name: "demo",
  });
  expect(mocks.clear).not.toHaveBeenCalled();
});
