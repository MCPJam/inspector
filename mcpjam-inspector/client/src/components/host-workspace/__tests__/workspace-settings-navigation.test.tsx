import { useEffect, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  mounted: vi.fn(),
  closed: vi.fn(),
  discover: vi.fn(),
  onboarding: vi.fn(),
}));
vi.mock("../thread-app-api", async (original) => ({
  ...(await original<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({
    discover: async () => [],
    discoverServer: async () => ({
      entries: [],
      mentions: { available: false },
      mentionsReported: true,
    }),
    onboarding: f.onboarding,
  }),
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: f.discover }),
}));
vi.mock("../ServerSettingsPanel", () => ({
  ServerSettingsPanel: ({
    serverId,
    serverName,
  }: {
    serverId: string;
    serverName: string;
  }) => {
    useEffect(() => {
      f.mounted(serverId);
      return () => f.closed(serverId);
    }, [serverId]);
    return (
      <label>
        {serverName} preference
        <input aria-label={`${serverName} preference`} defaultValue="initial" />
      </label>
    );
  },
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  WidgetWorkspaceSurfaceHost: () => null,
  useWidgetWorkspace: () => ({
    surfaces: { getState: () => ({ surfaces: new Map() }) },
  }),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
import { useThreadAppWorkspace } from "../ThreadAppPanel";
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const servers = [
  { serverId: "a", name: "Bits" },
  { serverId: "b", name: "Bolts" },
];
function Host({
  active = scope,
  run,
}: {
  active?: typeof scope | null;
  run?: import("../use-plugin-onboarding").RunPluginOnboarding;
}) {
  const workspace = useThreadAppWorkspace(active, servers, {
    runOnboarding: run,
  });
  return (
    <>
      {Object.values(workspace.menus).map((menu, index) => (
        <span key={index}>{menu(() => {})}</span>
      ))}
      {workspace.navigation}
      <div hidden={!workspace.open}>{workspace.panel}</div>
    </>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  f.discover.mockResolvedValue(true);
  f.onboarding.mockResolvedValue({
    available: true,
    spec: { pluginId: "fixture" },
  });
});
async function openSettings(
  user: ReturnType<typeof userEvent.setup>,
  server: string,
) {
  await user.click(
    await screen.findByRole("button", { name: `${server} extensions` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Settings" }));
}
describe("settings in existing workspace navigation", () => {
  it("retains drafts on hide/reopen and disposes only on explicit close", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await openSettings(user, "Bits");
    await user.clear(screen.getByLabelText("Bits preference"));
    await user.type(screen.getByLabelText("Bits preference"), "draft");
    await user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(f.closed).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Apps (1)" }));
    expect(screen.getByLabelText("Bits preference")).toHaveValue("draft");
    expect(f.mounted).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(f.closed).toHaveBeenCalledWith("a");
    await openSettings(user, "Bits");
    expect(screen.getByLabelText("Bits preference")).toHaveValue("initial");
    expect(f.mounted).toHaveBeenCalledTimes(2);
  });
  it("switches settings tabs without remounting and revokes them when scope changes", async () => {
    const user = userEvent.setup();
    const view = render(<Host />);
    await openSettings(user, "Bits");
    await openSettings(user, "Bolts");
    await user.click(screen.getByRole("tab", { name: "Bits settings" }));
    expect(f.mounted).toHaveBeenCalledTimes(2);
    expect(f.closed).not.toHaveBeenCalled();
    view.rerender(<Host active={null} />);
    await waitFor(() => expect(f.closed).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByRole("button", { name: "Bits extensions" }),
    ).toBeNull();
  });
});

describe("onboarding through the existing chip menu", () => {
  it.each([
    ["In this chat", "current"],
    ["In a new chat", "new"],
  ] as const)(
    "runs only after explicit %s selection",
    async (label, conversation) => {
      f.discover.mockResolvedValue(false);
      const run = vi.fn(async () => {});
      const user = userEvent.setup();
      render(<Host run={run} />);
      await user.click(
        await screen.findByRole("button", { name: "Bits extensions" }),
      );
      expect(run).not.toHaveBeenCalled();
      expect(f.onboarding.mock.calls.every((call) => call[1] === false)).toBe(
        true,
      );
      screen.getByRole("menuitem", { name: "Run onboarding" }).focus();
      await user.keyboard("{ArrowRight}");
      const action = await screen.findByRole("menuitem", { name: label });
      action.focus();
      await user.keyboard("{Enter}");
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
      expect(run).toHaveBeenCalledWith(
        { pluginId: "fixture" },
        conversation,
        expect.any(AbortSignal),
        "a",
      );
      expect(
        f.onboarding.mock.calls.filter((call) => call[1] === true),
      ).toHaveLength(1);
      expect(f.mounted).not.toHaveBeenCalled();
    },
  );
  it("does not advertise or read onboarding without a caller execution adapter", async () => {
    f.discover.mockResolvedValue(false);
    render(<Host />);
    await waitFor(() => expect(f.discover).toHaveBeenCalled());
    expect(f.onboarding).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Bits extensions" }),
    ).toBeNull();
  });
});
