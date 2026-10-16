import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hostedMode: true,
  isAuthenticated: true,
  query: vi.fn(),
  start: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({ query: state.query }),
  useConvexAuth: () => ({ isAuthenticated: state.isAuthenticated }),
  useQuery: (_ref: unknown, args: unknown) =>
    args === "skip" ? undefined : [{ _id: "ws_1", organizationId: "org_1" }],
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "user_1" } }),
}));
vi.mock("@/lib/config", () => ({
  get HOSTED_MODE() {
    return state.hostedMode;
  },
}));
vi.mock("@/lib/plugins/plugin-sign-in", () => ({
  startPluginServerSignIn: state.start,
}));
vi.mock("@/lib/toast", () => ({ toast: { error: state.toastError } }));

import {
  PLUGIN_SIGN_IN_UNAVAILABLE_MESSAGE,
  usePluginServerSignIn,
} from "../usePluginServerSignIn";

const binding = { pluginVersionId: "ver_mail", componentKey: "inbox" };
const target = {
  pluginId: "plg_mail",
  ...binding,
  serverId: "srv_mail",
  serverName: "mail",
  serverUrl: "https://mail.example.com/mcp",
  scopes: [],
};

describe("usePluginServerSignIn", () => {
  beforeEach(() => {
    state.hostedMode = true;
    state.isAuthenticated = true;
    state.query.mockReset();
    state.start.mockReset();
    state.toastError.mockReset();
  });

  it("offers no sign-in outside the hosted build, or signed out", () => {
    state.hostedMode = false;
    expect(
      renderHook(() => usePluginServerSignIn("ws_1")).result.current.available,
    ).toBe(false);
    state.hostedMode = true;
    state.isAuthenticated = false;
    expect(
      renderHook(() => usePluginServerSignIn("ws_1")).result.current.available,
    ).toBe(false);
  });

  it("resolves the server through its plugin, then starts the flow for this member and project", async () => {
    state.query.mockResolvedValue(target);
    state.start.mockResolvedValue({ success: true });
    const { result } = renderHook(() => usePluginServerSignIn("ws_1"));

    await act(() => result.current.signIn(binding));

    expect(state.query).toHaveBeenCalledWith(expect.anything(), {
      projectId: "ws_1",
      ...binding,
    });
    expect(state.start).toHaveBeenCalledWith({
      target,
      projectId: "ws_1",
      organizationId: "org_1",
      initiatingUserId: "user_1",
    });
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it("says sign-in isn't available when the backend has no such read yet", async () => {
    state.query.mockRejectedValue(
      new Error(
        "[CONVEX Q(pluginSignIn:resolvePluginServerSignIn)] Could not find public function for 'pluginSignIn:resolvePluginServerSignIn'",
      ),
    );
    const { result } = renderHook(() => usePluginServerSignIn("ws_1"));

    await act(() => result.current.signIn(binding));

    expect(state.start).not.toHaveBeenCalled();
    expect(state.toastError).toHaveBeenCalledWith(
      PLUGIN_SIGN_IN_UNAVAILABLE_MESSAGE,
    );
  });

  it("says why when the flow cannot start", async () => {
    state.query.mockResolvedValue(target);
    state.start.mockResolvedValue({ success: false, error: "No metadata" });
    const { result } = renderHook(() => usePluginServerSignIn("ws_1"));

    await act(() => result.current.signIn(binding));

    expect(state.toastError).toHaveBeenCalledWith("No metadata");
    expect(result.current.pendingKey).toBeNull();
  });
});
