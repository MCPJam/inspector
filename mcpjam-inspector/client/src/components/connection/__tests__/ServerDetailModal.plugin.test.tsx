/**
 * A plugin's server opens the same server details dialog, as its Settings
 * tab: the Plugin section, then the server's own extension settings when it
 * declares any. No configuration form and no connect switch — the server
 * belongs to the plugin's version and connects on every message.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settingsAvailable: false,
  sectionProps: [] as unknown[],
}));

vi.mock("../../host-workspace/use-server-settings", () => ({
  useServerSettingsAvailability: (scope: unknown) => ({
    available: !!scope && h.settingsAvailable,
    failed: false,
    retry: vi.fn(),
  }),
}));
vi.mock("../../host-workspace/ServerSettingsPanel", () => ({
  ServerSettingsPanel: () => <div data-testid="settings-view">Settings</div>,
}));
vi.mock("@/components/plugins/PluginSettingsSection", () => ({
  PluginSettingsSection: (props: unknown) => {
    h.sectionProps.push(props);
    return <div data-testid="plugin-settings-section" />;
  },
}));

import { ServerDetailModal } from "../ServerDetailModal";

const detail = {
  pluginId: "pl_bits",
  pluginLabel: "Bits & Bolts",
  serverId: "s_cad",
  serverName: "cad",
};

const scope = {
  projectId: "p_1",
  hostId: "h_1",
  threadId: "settings:plugin:pl_bits",
  pluginWorkspace: { version: 1 as const, workspaceId: "w" },
};

beforeEach(() => {
  h.settingsAvailable = false;
  h.sectionProps = [];
});

describe("ServerDetailModal for a plugin's server", () => {
  it("opens on Settings with the Plugin section, badge and no connect switch", () => {
    const onClose = vi.fn();
    render(
      <ServerDetailModal
        isOpen
        plugin={detail}
        onClose={onClose}
        projectId="p_1"
      />,
    );
    expect(screen.getByTestId("plugin-server-detail-modal")).toBeTruthy();
    expect(screen.getByText("cad")).toBeTruthy();
    expect(screen.getByText("from Bits & Bolts")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Configuration" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByTestId("plugin-settings-section")).toBeTruthy();
    expect(h.sectionProps.at(-1)).toMatchObject({
      projectId: "p_1",
      pluginId: "pl_bits",
      focusServerId: "s_cad",
      onUninstalled: onClose,
    });
    expect(screen.queryByTestId("settings-view")).toBeNull();
  });

  it("adds the server's extension settings below when it declares any", () => {
    h.settingsAvailable = true;
    render(
      <ServerDetailModal
        isOpen
        plugin={detail}
        onClose={vi.fn()}
        projectId="p_1"
        extensionSettingsScope={scope}
      />,
    );
    expect(screen.getByTestId("plugin-settings-section")).toBeTruthy();
    expect(screen.getByTestId("settings-view")).toBeTruthy();
  });
});
