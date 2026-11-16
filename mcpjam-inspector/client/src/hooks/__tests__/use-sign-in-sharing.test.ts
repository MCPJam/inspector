import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { useSignInSharing } from "../use-sign-in-sharing";

const state = vi.hoisted(() => ({
  flag: true,
  admin: { canManage: true, isLoading: false },
  roleArgs: [] as unknown[],
  mutations: [] as string[],
  save: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "eval-account-selection-enabled" ? state.flag : false,
}));
vi.mock("@/hooks/useProjects", () => ({
  useCanManageProjectClients: (args: unknown) => {
    state.roleArgs.push(args);
    return state.admin;
  },
}));
vi.mock("convex/react", () => ({
  // Each mutation calls through with its own name, so a test can tell which
  // write ran, not only that one did.
  useMutation: (reference: never) => {
    const name = getFunctionName(reference);
    state.mutations.push(name);
    return (args: unknown) => state.save(name, args);
  },
}));
vi.mock("@/lib/apis/web/oauth-connections", () => ({
  notifyOAuthConnectionsChanged: state.notify,
}));

function sharing() {
  return renderHook(() =>
    useSignInSharing({
      projectId: "project-1",
      serverId: "server-1",
      enabled: true,
    }),
  ).result.current;
}

describe("useSignInSharing", () => {
  beforeEach(() => {
    state.flag = true;
    state.admin = { canManage: true, isLoading: false };
    state.roleArgs = [];
    state.mutations = [];
    state.save.mockReset().mockResolvedValue({ oauthSharing: "shared" });
    state.notify.mockReset();
  });

  it("offers the share control to a project admin while the flag is on", () => {
    expect(sharing()).toMatchObject({ isAdmin: true, canShare: true });
    expect(state.roleArgs).toContainEqual({
      isAuthenticated: true,
      projectId: "project-1",
    });
  });

  it("never offers it to a member, and treats them as one", () => {
    state.admin = { canManage: false, isLoading: false };
    expect(sharing()).toMatchObject({ isAdmin: false, canShare: false });
  });

  it("hides it from an admin while the flag is off", () => {
    state.flag = false;
    expect(sharing()).toMatchObject({ isAdmin: true, canShare: false });
  });

  it("writes the server's sharing, then has the accounts list read again", async () => {
    await sharing().setSharing("personal");
    expect(state.save).toHaveBeenCalledWith("servers:setServerOAuthSharing", {
      serverId: "server-1",
      oauthSharing: "personal",
    });
    expect(state.notify).toHaveBeenCalledOnce();
  });

  it("allows local runs with a share, since the dialog disclosed them", async () => {
    await sharing().setSharing("shared");
    expect(state.save).toHaveBeenCalledWith("servers:setServerOAuthSharing", {
      serverId: "server-1",
      oauthSharing: "shared",
      acknowledgeLocalDelivery: true,
    });
  });

  it("allows or stops local runs for an existing share", async () => {
    await sharing().setLocalRuns(true);
    expect(state.save).toHaveBeenCalledWith(
      "credentials:setServerLocalDelivery",
      { serverId: "server-1", allowed: true },
    );
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.notify).toHaveBeenCalledOnce();
  });

  it("leaves the list alone when the write is refused", async () => {
    state.save.mockRejectedValue(new Error("refused"));
    await expect(sharing().setSharing("shared")).rejects.toThrow("refused");
    expect(state.notify).not.toHaveBeenCalled();
  });
});
