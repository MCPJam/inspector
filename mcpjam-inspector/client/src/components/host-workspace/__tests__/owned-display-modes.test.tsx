import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadAppWorkspace } from "../ThreadAppPanel";
const f = vi.hoisted(() => ({
  register: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("../thread-app-api", async (original) => ({
  ...(await original<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({
    discover: async () => [],
    open: async () => ({
      instanceId: "owned",
      operationId: "original",
      widgetContent: { html: "app" },
    }),
    invoke: f.invoke,
    close: async () => {},
  }),
}));
const surfaces = { surfaces: new Map(), upsertRegistration: f.register };
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: any) => children,
  WidgetWorkspaceSurfaceHost: () => null,
  useWidgetWorkspace: () => ({
    workspaceId: "workspace",
    surfaces: { getState: () => surfaces },
  }),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({
    environment: {},
    surface: {},
    resolvers: {
      resolveEffectiveMcpAppsCapabilities: () => ({
        availableDisplayModes: ["inline", "fullscreen"],
        widgetDisplayModeRequests: "accept",
      }),
    },
  }),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const server = { serverId: "saved", name: "Fixture" };
const declaration = { kind: "thread" as const, title: "App", toolName: "app" };
function Harness() {
  const workspace = useThreadAppWorkspace(scope, [server]);
  return (
    <>
      {workspace.panel}
      <button onClick={() => void workspace.launch(server, declaration)}>
        Launch
      </button>
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("owned App display mode", () => {
  it("draws the App right after it opens, fullscreen, and delivers the result to the same registration", async () => {
    let finish!: (value: { content: never[] }) => void;
    f.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    fireEvent.click(screen.getByText("Launch"));
    // Rendered while its first call is still running: the App shows its own
    // loading state, not the host's.
    await waitFor(() => expect(f.register).toHaveBeenCalled());
    const latest = () => f.register.mock.calls.at(-1)!;
    expect(latest()[0]).toBe("owned");
    expect(latest()[2].toolState).toBe("input-available");
    expect(latest()[2].displayMode).toBe("fullscreen");
    expect(latest()[2].fullscreenWidgetId).toBe("owned");
    expect(screen.queryByText("Opening App…")).not.toBeInTheDocument();
    await act(async () => finish({ content: [] }));
    await waitFor(() =>
      expect(latest()[2].toolState).toBe("output-available"),
    );
    expect(latest()[0]).toBe("owned");
    expect(latest()[2].toolOutput).toEqual({ content: [] });
    // App requests to leave fullscreen change nothing.
    act(() => latest()[2].onDisplayModeChange("inline"));
    act(() => latest()[2].onAppSupportedDisplayModesChange(["inline"]));
    expect(latest()[2].displayMode).toBe("fullscreen");
    expect(
      screen.queryByRole("button", { name: "App display mode" }),
    ).not.toBeInTheDocument();
    // Hide and reopen: same instance, never activated twice.
    fireEvent.click(screen.getByText("Back to chat"));
    fireEvent.click(screen.getByText("Launch"));
    expect(latest()[0]).toBe("owned");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});
