import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadAppWorkspace } from "../ThreadAppPanel";
import { ThreadAppError } from "../thread-app-api";

const f = vi.hoisted(() => ({
  discover: vi.fn(),
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  track: vi.fn(),
}));
vi.mock("@/lib/analytics", () => ({ track: f.track }));
vi.mock("../thread-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({ ...f }),
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  WidgetWorkspaceSurfaceHost: () => null,
  useWidgetWorkspace: () => ({}),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));

const scope = {
  projectId: "project",
  hostId: "client",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const servers = [{ serverId: "saved", name: "Saved server" }];
const declaration = { toolName: "app", title: "App", kind: "thread" as const };
const handle = {
  instanceToken: "private-token",
  instanceId: "instance",
  operationId: "private-operation",
};
const outcomes = () =>
  f.track.mock.calls
    .filter((call) => call[0] === "extension_launch_completed")
    .map((call) => call[1]);

describe("App launch health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.discover.mockResolvedValue([declaration]);
    f.open.mockResolvedValue(handle);
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("counts one success once the call returns and the App first renders", async () => {
    const { result } = renderHook(() =>
      useThreadAppWorkspace(scope, servers, { launchProfile: "codex" }),
    );
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(outcomes()).toEqual([]);
    const key = result.current.apps[0].key;
    act(() => result.current.appPorts!.renderOutcome!(key, "ready"));
    act(() => result.current.appPorts!.renderOutcome!(key, "error"));
    // Reopening the retained App is not another launch.
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(outcomes()).toEqual([
      {
        launch_kind: "thread",
        host_profile: "codex",
        outcome: "success",
        failure_stage: "none",
        location: "host_workspace",
      },
    ]);
    expect(JSON.stringify(f.track.mock.calls)).not.toContain("private");
  });

  it("counts an execution failure once across retries of the same activation", async () => {
    f.invoke
      .mockRejectedValueOnce(new ThreadAppError("INSTANCE_UNAVAILABLE"))
      .mockResolvedValue({ content: [] });
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    act(() =>
      result.current.appPorts!.renderOutcome!(result.current.apps[0].key, "ready"),
    );
    expect(outcomes().map((outcome) => outcome.failure_stage)).toEqual([
      "execution",
    ]);
  });

  it("counts a render failure, and leaves denials and deliberate closes out", async () => {
    const render = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await render.result.current.launch(servers[0], declaration);
    });
    act(() =>
      render.result.current.appPorts!.renderOutcome!(
        render.result.current.apps[0].key,
        "error",
      ),
    );
    expect(outcomes().map((outcome) => outcome.failure_stage)).toEqual([
      "rendering",
    ]);
    render.unmount();

    f.track.mockClear();
    f.invoke.mockRejectedValue(new ThreadAppError("APPROVAL_DENIED"));
    const denied = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await denied.result.current.launch(servers[0], declaration);
    });
    expect(outcomes()).toEqual([]);
    denied.unmount();

    let fail!: (error: Error) => void;
    f.invoke.mockImplementation(
      () => new Promise((_, reject) => (fail = reject)),
    );
    const closed = renderHook(() => useThreadAppWorkspace(scope, servers));
    act(() => {
      void closed.result.current.launch(servers[0], declaration);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await closed.result.current.close(closed.result.current.apps[0]);
      fail(new Error("aborted"));
    });
    expect(outcomes()).toEqual([]);
  });
});
