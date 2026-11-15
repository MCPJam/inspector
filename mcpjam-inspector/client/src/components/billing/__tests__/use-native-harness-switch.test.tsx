import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  switchedClientsMessage,
  useNativeHarnessSwitch,
} from "../use-native-harness-switch";

const switchMock = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: () => switchMock,
}));

const hostListArgs = vi.hoisted(() => vi.fn());
const hosts = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
vi.mock("@/hooks/useClients", () => ({
  useHostList: (args: unknown) => {
    hostListArgs(args);
    return { hosts: hosts.value, isLoading: false };
  },
}));

const admin = vi.hoisted(() => ({ value: true }));
vi.mock("@/hooks/useProjects", () => ({
  useCanManageProjectClients: () => ({ canManage: admin.value, isLoading: false }),
}));

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

beforeEach(() => {
  switchMock.mockReset();
  hostListArgs.mockReset();
  toastMock.success.mockReset();
  toastMock.info.mockReset();
  toastMock.error.mockReset();
  admin.value = true;
  hosts.value = [
    { hostId: "chatgpt", agentLoop: "codex" },
    { hostId: "claude-code", harness: "claude-code" },
    { hostId: "gemini" },
    { hostId: "cursor", agentLoop: null, harness: "cursor" },
  ];
});

describe("useNativeHarnessSwitch", () => {
  it("counts the project's clients on a native harness, for a project admin", () => {
    const { result } = renderHook(() => useNativeHarnessSwitch("proj_1"));

    expect(result.current.switchCount).toBe(3);
    expect(hostListArgs).toHaveBeenCalledWith({
      isAuthenticated: true,
      projectId: "proj_1",
    });
  });

  it("offers nothing to anyone else, or without a project", () => {
    admin.value = false;
    expect(
      renderHook(() => useNativeHarnessSwitch("proj_1")).result.current
        .switchCount,
    ).toBe(0);
    admin.value = true;
    expect(
      renderHook(() => useNativeHarnessSwitch(null)).result.current.switchCount,
    ).toBe(0);
  });

  it("switches the project and says what changed", async () => {
    switchMock.mockResolvedValue({ switched: 3, skipped: 0 });
    const { result } = renderHook(() => useNativeHarnessSwitch("proj_1"));

    let switched = false;
    await act(async () => {
      switched = await result.current.switchClients();
    });

    expect(switched).toBe(true);
    expect(switchMock).toHaveBeenCalledWith({ projectId: "proj_1" });
    expect(toastMock.success).toHaveBeenCalledWith(
      "3 clients now run on MCPJam Harness.",
    );
  });

  // Every native client sits in another member's study, say: the person is
  // still out of turns, so the dialog has to stay open.
  it("reports no switch when no client moved, and says why", async () => {
    switchMock.mockResolvedValue({
      switched: 0,
      skipped: 2,
      skippedReasons: { client_locked_by_study: 2, feature_unavailable: 0 },
    });
    const { result } = renderHook(() => useNativeHarnessSwitch("proj_1"));

    let switched = true;
    await act(async () => {
      switched = await result.current.switchClients();
    });

    expect(switched).toBe(false);
    expect(toastMock.info).toHaveBeenCalledWith(
      "2 clients in another member's study kept their native harness.",
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("shows a refusal in the backend's words and reports no switch", async () => {
    switchMock.mockRejectedValue(
      new ConvexError({
        code: "too_many_clients",
        message: "This project has more than 100 clients. Switch them one at a time.",
      }),
    );
    const { result } = renderHook(() => useNativeHarnessSwitch("proj_1"));

    let switched = true;
    await act(async () => {
      switched = await result.current.switchClients();
    });

    expect(switched).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith(
      "This project has more than 100 clients. Switch them one at a time.",
    );
  });
});

describe("switchedClientsMessage", () => {
  it("says what now runs on MCPJam Harness, singular for one client", () => {
    expect(switchedClientsMessage({ switched: 1, skipped: 0 })).toBe(
      "1 client now runs on MCPJam Harness.",
    );
  });

  it("names why clients kept their native harness, when one reason covers them", () => {
    expect(
      switchedClientsMessage({
        switched: 2,
        skipped: 1,
        skippedReasons: { client_locked_by_study: 1, feature_unavailable: 0 },
      }),
    ).toBe(
      "2 clients now run on MCPJam Harness. 1 client in another member's study kept its native harness.",
    );
    expect(
      switchedClientsMessage({
        switched: 0,
        skipped: 2,
        skippedReasons: { client_locked_by_study: 0, feature_unavailable: 2 },
      }),
    ).toBe(
      "2 clients kept their native harness because their computer needs a feature your organization doesn't have.",
    );
  });

  it("sends the person to the clients for mixed reasons, or none sent", () => {
    expect(
      switchedClientsMessage({
        switched: 1,
        skipped: 3,
        skippedReasons: { client_locked_by_study: 1, feature_unavailable: 2 },
      }),
    ).toBe(
      "1 client now runs on MCPJam Harness. 3 clients kept their native harness. Open each client to see why.",
    );
    // An older backend counts skipped clients without saying why.
    expect(switchedClientsMessage({ switched: 0, skipped: 1 })).toBe(
      "1 client kept its native harness. Open the client to see why.",
    );
    expect(switchedClientsMessage({ switched: 0, skipped: 0 })).toBe(
      "No clients needed a change.",
    );
  });
});
