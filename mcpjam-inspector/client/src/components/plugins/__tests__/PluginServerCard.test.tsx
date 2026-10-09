/**
 * A plugin's server on the Servers tab: the project server card's look, a
 * "from <plugin>" badge, the plugin's status where the connect switch sits,
 * Settings on click or ⋮ → Configure, and ⋮ → "Uninstall plugin…" (admins).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";

const h = vi.hoisted(() => ({
  version: { value: undefined as unknown },
  setupStatus: { value: undefined as unknown },
  softDeletePlugin: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  usePluginVersion: () => h.version.value,
  usePluginSetupStatus: () => h.setupStatus.value,
  usePluginManagementActions: () => ({
    setEnabled: vi.fn(),
    activateVersion: vi.fn(),
    softDeletePlugin: h.softDeletePlugin,
    restorePlugin: vi.fn(),
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: h.toastError } }));

import { PluginServerCard } from "../PluginServerCard";
import { InstalledPluginServerCards } from "../InstalledPluginServerCards";
import { SERVER_CARD_CLASS_NAME } from "@/components/connection/server-card-utils";

const plugin: PluginSummary = {
  pluginId: "pl_bits",
  projectId: "p_1",
  name: "bits-and-bolts",
  displayName: "Bits & Bolts",
  enabled: true,
  activeVersionId: "pv_1",
  createdAt: 1,
  updatedAt: 1,
};

const server = {
  serverId: "s_cad",
  name: "cad",
  placement: "remote" as const,
  componentKey: "server:cad",
};

function openMenu() {
  // Radix opens its dropdown on pointerdown, not click.
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Open actions menu for cad" }),
    { button: 0, ctrlKey: false, pointerType: "mouse" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.softDeletePlugin.mockResolvedValue(undefined);
  h.version.value = undefined;
  h.setupStatus.value = undefined;
});

describe("PluginServerCard", () => {
  it("is the server card, with a from-plugin badge and the plugin's status", () => {
    render(
      <PluginServerCard
        plugin={plugin}
        server={server}
        status={{ label: "Needs sign-in", tone: "attention" }}
        canManage
        onOpenSettings={vi.fn()}
      />,
    );
    const card = screen.getByTestId("plugin-server-card");
    for (const cls of SERVER_CARD_CLASS_NAME.split(" ")) {
      expect(card.className).toContain(cls);
    }
    expect(screen.getByText("cad")).toBeTruthy();
    expect(screen.getByTestId("plugin-server-badge").textContent).toBe(
      "from Bits & Bolts",
    );
    expect(screen.getByTestId("plugin-server-status").textContent).toBe(
      "Needs sign-in",
    );
    // No connect switch: the chat route connects plugin servers itself.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("opens Settings from a card click and from ⋮ → Configure", async () => {
    const onOpenSettings = vi.fn();
    render(
      <PluginServerCard
        plugin={plugin}
        server={server}
        status={{ label: "Active", tone: "active" }}
        canManage
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-server-card"));
    expect(onOpenSettings).toHaveBeenCalledWith("s_cad");

    openMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Configure" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("uninstalls the plugin from ⋮ after the confirm", async () => {
    render(
      <PluginServerCard
        plugin={plugin}
        server={server}
        status={{ label: "Active", tone: "active" }}
        canManage
        onOpenSettings={vi.fn()}
      />,
    );
    openMenu();
    expect(
      screen.queryByRole("menuitem", { name: /Remove server/ }),
    ).toBeNull();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Uninstall plugin…" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    });
    expect(h.softDeletePlugin).toHaveBeenCalledWith("pl_bits");
  });

  it("gives a member Uninstall disabled, with the reason", async () => {
    render(
      <PluginServerCard
        plugin={plugin}
        server={server}
        status={{ label: "Active", tone: "active" }}
        canManage={false}
        onOpenSettings={vi.fn()}
      />,
    );
    openMenu();
    const item = await screen.findByRole("menuitem", {
      name: "Uninstall plugin…",
    });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByTestId("plugin-server-card-admin-reason").textContent,
    ).toBe("Only project admins can activate, disable or uninstall plugins.");
  });
});

describe("InstalledPluginServerCards", () => {
  const activeRow = {
    pluginId: "pl_bits",
    pluginVersionId: "pv_1",
    name: "bits-and-bolts",
    displayName: "Bits & Bolts",
    status: "active" as const,
    servers: [
      {
        serverId: "s_cad",
        name: "bits-and-bolts:cad@aa11bb22",
        componentKey: "server:cad",
        placement: "remote" as const,
      },
    ],
    skills: [],
  };

  it("names each server as the bundle declares it, with the plugin's status", () => {
    h.version.value = {
      pluginVersionId: "pv_1",
      servers: [
        {
          componentId: "c_1",
          componentKey: "server:cad",
          declaredName: "cad",
          placement: "remote",
          authenticationPolicy: "on_install",
          materializedServerId: "s_cad",
        },
      ],
      skills: [],
    };
    const onOpenSettings = vi.fn();
    render(
      <InstalledPluginServerCards
        plugin={plugin}
        row={activeRow}
        canManage
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.getByText("cad")).toBeTruthy();
    expect(screen.getByTestId("plugin-server-status").textContent).toBe(
      "Active",
    );
    fireEvent.click(screen.getByTestId("plugin-server-card"));
    expect(onOpenSettings).toHaveBeenCalledWith({
      pluginId: "pl_bits",
      pluginLabel: "Bits & Bolts",
      serverId: "s_cad",
      serverName: "cad",
    });
  });

  it("falls back to the active-plugins row until the version arrives", () => {
    render(
      <InstalledPluginServerCards
        plugin={plugin}
        row={{ ...activeRow, status: "skipped", reason: "needs_setup" }}
        canManage
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByText("bits-and-bolts:cad@aa11bb22")).toBeTruthy();
    expect(screen.getByTestId("plugin-server-status").textContent).toBe(
      "Needs setup",
    );
  });

  it("gives an installed plugin with no active version its own card, opening its Settings", async () => {
    const installOnly = { ...plugin, activeVersionId: undefined };
    const onOpenSettings = vi.fn();
    render(
      <InstalledPluginServerCards
        plugin={installOnly}
        row={{
          ...activeRow,
          pluginVersionId: null,
          status: "skipped",
          reason: "no_active_version",
          servers: [],
        }}
        canManage
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(screen.queryByTestId("plugin-server-card")).toBeNull();
    const card = screen.getByTestId("plugin-card");
    for (const cls of SERVER_CARD_CLASS_NAME.split(" ")) {
      expect(card.className).toContain(cls);
    }
    expect(screen.getByText("Bits & Bolts")).toBeTruthy();
    // No "from" badge: the card is the plugin itself.
    expect(screen.queryByTestId("plugin-server-badge")).toBeNull();
    expect(screen.getByTestId("plugin-server-status").textContent).toBe(
      "Not activated",
    );

    fireEvent.click(card);
    expect(onOpenSettings).toHaveBeenCalledWith({
      pluginId: "pl_bits",
      pluginLabel: "Bits & Bolts",
      serverId: null,
      serverName: "Bits & Bolts",
    });

    // Uninstall is on its menu too.
    fireEvent.pointerDown(
      screen.getByRole("button", {
        name: "Open actions menu for Bits & Bolts",
      }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Uninstall plugin…" }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    });
    expect(h.softDeletePlugin).toHaveBeenCalledWith("pl_bits");
  });

  it("renders nothing for a plugin with only skills", () => {
    const { container } = render(
      <InstalledPluginServerCards
        plugin={plugin}
        row={{ ...activeRow, servers: [] }}
        canManage
        onOpenSettings={vi.fn()}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
