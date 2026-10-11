import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  discover: vi.fn(),
  approve: undefined as any,
  mounted: vi.fn(),
  unmounted: vi.fn(),
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: (...args: unknown[]) => ({
    discover: (signal: AbortSignal) => f.discover(args[1], signal),
  }),
}));
vi.mock("../../chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("../ServerSettingsView", () => ({
  ServerSettingsView: (props: any) => {
    f.approve = props.approve;
    return <div>{props.serverName} settings view</div>;
  },
}));
import { ServerSettingsPanel } from "../ServerSettingsPanel";
import { useServerSettingsAvailability } from "../use-server-settings";
import { useWorkspaceSettings } from "../use-workspace-settings";
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
beforeEach(() => {
  vi.clearAllMocks();
  f.discover.mockResolvedValue(true);
});
describe("shared settings surfaces", () => {
  it("shows arguments and accepts or denies inline without another dialog", async () => {
    const ui = render(
      <ServerSettingsPanel
        scope={scope}
        serverId="server"
        serverName="Bits & Bolts"
      />,
    );
    let answer!: Promise<boolean>;
    await act(async () => {
      answer = f.approve(
        { name: "reset", params: { count: 0 } },
        new AbortController().signal,
      );
    });
    expect(screen.getByText(/"count": 0/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await answer).toBe(true);
    await act(async () => {
      answer = f.approve({ name: "reset" }, new AbortController().signal);
    });
    ui.unmount();
    expect(await answer).toBe(false);
  });
  it("never discovers with a missing scope and fences a stale selected-server result", async () => {
    let resolve!: (value: boolean) => void;
    f.discover.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = renderHook(
      ({ active, id }) => useServerSettingsAvailability(active, id),
      { initialProps: { active: null as typeof scope | null, id: "a" } },
    );
    expect(f.discover).not.toHaveBeenCalled();
    view.rerender({ active: scope, id: "a" });
    view.rerender({ active: scope, id: "b" });
    await waitFor(() => expect(view.result.current.available).toBe(true));
    await act(async () => resolve(false));
    expect(view.result.current.available).toBe(true);
    expect(f.discover.mock.calls[0][1].aborted).toBe(true);
  });
  it("reports discovery failures and retries without opening settings", async () => {
    f.discover.mockRejectedValueOnce(new Error("offline"));
    const view = renderHook(() =>
      useWorkspaceSettings(scope, [{ serverId: "server", name: "Bits" }]),
    );
    await waitFor(() =>
      expect(view.result.current.failedServerIds).toEqual(["server"]),
    );
    expect(view.result.current.panel).toBeNull();
    act(() => view.result.current.retryDiscovery());
    await waitFor(() =>
      expect(view.result.current.availableServerIds).toEqual(["server"]),
    );
    expect(view.result.current.failedServerIds).toEqual([]);
    expect(view.result.current.panel).toBeNull();
  });
  it("opens only discovered settings and drops selection when authority scope changes", async () => {
    const view = renderHook(
      ({ active }) =>
        useWorkspaceSettings(active, [{ serverId: "server", name: "Bits" }]),
      { initialProps: { active: scope } },
    );
    await waitFor(() =>
      expect(view.result.current.availableServerIds).toEqual(["server"]),
    );
    act(() => view.result.current.open("unknown"));
    expect(view.result.current.panel).toBeNull();
    act(() => view.result.current.open("server"));
    expect(view.result.current.activeServerId).toBe("server");
    view.rerender({ active: { ...scope, hostId: "new-host" } });
    expect(view.result.current.panel).toBeNull();
  });
});
