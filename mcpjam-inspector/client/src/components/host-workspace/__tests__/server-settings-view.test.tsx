import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSettingsController } from "@/shared/plugin-settings-controller";
import { settingsFixture } from "@/shared/__tests__/plugin-settings-fixture";
const f = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ open: f.open }),
}));
vi.mock("../SettingsInlineApp", () => ({
  SettingsInlineApp: () => <div>Inline settings App</div>,
}));
import { ServerSettingsView } from "../ServerSettingsView";
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const approve = vi.fn(async () => true);
let controller: NativeSettingsController,
  save: ReturnType<typeof vi.fn>,
  close: ReturnType<typeof vi.fn>,
  openApp: ReturnType<typeof vi.fn>,
  closeApp: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  save = vi.fn(async ({ set }) => ({
    values: { ...settingsFixture().values, ...set },
  }));
  controller = new NativeSettingsController(settingsFixture(), {
    read: async () => settingsFixture(),
    update: save,
  });
  close = vi.fn(async () => {});
  closeApp = vi.fn(async () => {});
  openApp = vi.fn(async () => ({ close: closeApp }));
  f.open.mockResolvedValue({
    controller,
    close,
    actions: [{ name: "reset", kind: "app" }],
    openApp,
    action: vi.fn(),
  });
});
describe("shared server settings view", () => {
  it("uses the server name and existing controlled editor to save without a dialog", async () => {
    const view = render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits & Bolts"
        approve={approve}
      />,
    );
    await screen.findByText("Bits & Bolts settings");
    await screen.findByLabelText("Count");
    fireEvent.change(screen.getByLabelText("Count"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({ set: { count: 0 } });
    expect(screen.queryByRole("dialog")).toBeNull();
    view.unmount();
    expect(close).toHaveBeenCalledOnce();
  });
  it("renders a settings App inline and releases its child on explicit close", async () => {
    render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
        host={{} as never}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await screen.findByText("Inline settings App");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close App" }));
    await waitFor(() => expect(closeApp).toHaveBeenCalledOnce());
    expect(screen.queryByText("Inline settings App")).toBeNull();
  });
  it("does not remount the owned settings session on an equivalent caller object or approval callback", async () => {
    const view = render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
      />,
    );
    await screen.findByLabelText("Count");
    view.rerender(
      <ServerSettingsView
        scope={{ ...scope }}
        serverId="server"
        serverName="Bits"
        approve={async () => true}
      />,
    );
    expect(f.open).toHaveBeenCalledOnce();
  });
});

describe("settings rows, replies and described errors", () => {
  it("shows booleans as switches in label-left rows", async () => {
    const fixture = settingsFixture();
    fixture.layout[0].items.push({ kind: "property", property: "enabled" });
    controller = new NativeSettingsController(fixture, {
      read: async () => fixture,
      update: save,
    });
    f.open.mockResolvedValue({
      controller,
      close,
      actions: [],
      openApp,
      action: vi.fn(),
    });
    render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
      />,
    );
    const toggle = await screen.findByRole("switch", { name: "Enabled" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0]).toEqual({ set: { enabled: true } });
  });

  it("shows the tool's own reply instead of a fixed Done", async () => {
    const action = vi.fn(async () => ({
      content: [
        { type: "text", text: "Reset 12 parts to their defaults." },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    }));
    f.open.mockResolvedValue({
      controller,
      close,
      actions: [{ name: "reset", kind: "tool" }],
      openApp,
      action,
    });
    render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    expect(
      await screen.findByText("Reset 12 parts to their defaults."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Done")).toBeNull();
  });

  it("marks a tool reply flagged isError as failed", async () => {
    f.open.mockResolvedValue({
      controller,
      close,
      actions: [{ name: "reset", kind: "tool" }],
      openApp,
      action: vi.fn(async () => ({
        isError: true,
        content: [{ type: "text", text: "Parts library is locked." }],
      })),
    });
    render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    const reply = await screen.findByText("Parts library is locked.");
    expect(reply.className).toMatch(/text-destructive/);
  });

  it("describes a settings error code in plain English and logs it", async () => {
    const { PluginSettingsRequestError } = await import(
      "@/shared/plugin-settings"
    );
    const { useTrafficLogStore } = await import("@/stores/traffic-log-store");
    useTrafficLogStore.getState().clear();
    f.open.mockRejectedValue(
      new PluginSettingsRequestError(
        "PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED",
        false,
      ),
    );
    render(
      <ServerSettingsView
        scope={scope}
        serverId="server"
        serverName="Bits"
        approve={approve}
      />,
    );
    expect(
      await screen.findByText(/settings tools need an outputSchema/),
    ).toBeInTheDocument();
    const entry = useTrafficLogStore
      .getState()
      .mcpServerItems.find(
        (item) =>
          item.method ===
          "plugin-extensions/PLUGIN_SETTINGS_OUTPUT_SCHEMA_REQUIRED",
      );
    expect(entry?.serverId).toBe("server");
  });
});
