/**
 * Plugin GROUP card: the card is a bundle, not a server. It must never claim a
 * plugin is ready while a component is not, it must show the components of the
 * ACTIVE revision when expanded, and it must not offer to delete a component
 * (plugin projections are read-only; removal routes through the plugin).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";

const h = vi.hoisted(() => ({
  version: { value: undefined as unknown },
  setupStatus: { value: undefined as unknown },
  detail: { value: undefined as unknown },
  setEnabled: vi.fn(),
  activateVersion: vi.fn(),
  softDeletePlugin: vi.fn(),
  restorePlugin: vi.fn(),
  track: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  usePluginVersion: () => h.version.value,
  usePluginSetupStatus: () => h.setupStatus.value,
  useProjectPlugin: () => h.detail.value,
  usePluginManagementActions: () => ({
    setEnabled: h.setEnabled,
    activateVersion: h.activateVersion,
    softDeletePlugin: h.softDeletePlugin,
    restorePlugin: h.restorePlugin,
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: h.track }));
vi.mock("@/lib/toast", () => ({ toast: { error: h.toastError } }));

import { PluginGroupCard } from "../PluginGroupCard";

const plugin: PluginSummary = {
  pluginId: "pl_1",
  projectId: "p_1",
  name: "demo",
  displayName: "Demo",
  enabled: true,
  activeVersionId: "pv_1",
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.detail.value = undefined;
  h.setupStatus.value = {
    pluginVersionId: "pv_1",
    status: "ready",
    components: [
      {
        componentKey: "server:api",
        placement: "remote",
        authenticationPolicy: "on_install",
        readiness: "needs_auth",
      },
    ],
  };
  h.version.value = {
    pluginVersionId: "pv_1",
    pluginId: "pl_1",
    bundleHash: "aa11bb22cc33dd44",
    declaredVersion: "1.0.0",
    status: "ready",
    manifestHash: "ff",
    componentCounts: {
      skills: 1,
      servers: 1,
      apps: 0,
      assets: 0,
      unsupported: 2,
    },
    createdAt: 1,
    servers: [
      {
        componentId: "c_1",
        componentKey: "server:api",
        declaredName: "api",
        placement: "remote",
        authenticationPolicy: "on_install",
        materializedServerId: "s_1",
      },
    ],
    skills: [
      {
        componentId: "c_2",
        componentKey: "skill:triage",
        declaredName: "triage",
        modelRef: "demo/triage",
        materializedSkillId: "sk_1",
      },
    ],
  };
});

describe("PluginGroupCard", () => {
  it("rolls a component that needs auth up into the card's health", () => {
    render(<PluginGroupCard plugin={plugin} />);
    expect(screen.getByTestId("plugin-health-badge").textContent).toBe(
      "Needs auth",
    );
  });

  it("reports a disabled plugin as disabled regardless of component health", () => {
    h.setupStatus.value = {
      pluginVersionId: "pv_1",
      status: "ready",
      components: [],
    };
    render(<PluginGroupCard plugin={{ ...plugin, enabled: false }} />);
    expect(screen.getByTestId("plugin-health-badge").textContent).toBe(
      "Disabled",
    );
  });

  it("shows the active revision's components when expanded, without a delete action", () => {
    render(<PluginGroupCard plugin={plugin} />);
    // The first collapsible control is the card header; the kebab trigger is
    // also a collapsed-state button.
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    const detail = screen.getByTestId("plugin-group-card-detail");
    expect(detail.textContent).toContain("api");
    expect(detail.textContent).toContain("demo/triage");
    expect(detail.textContent).toContain("aa11bb22cc33");
    // Unsupported components are named as preserved, never as executed.
    expect(detail.textContent).toMatch(/not run by MCPJam/i);
    expect(detail.textContent).not.toMatch(/remove|delete/i);
  });

  it("surfaces the backend's environment-pin conflict when uninstall is blocked", async () => {
    h.softDeletePlugin.mockRejectedValue(
      new Error('still pinned by environment "Staging"'),
    );
    render(<PluginGroupCard plugin={plugin} />);
    // Radix opens its dropdown on pointerdown, not click.
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /Plugin actions for Demo/ }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Uninstall" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Uninstall" }),
      );
    });
    expect(h.toastError).toHaveBeenCalledWith(
      'still pinned by environment "Staging"',
    );
    expect(h.track).not.toHaveBeenCalled();
  });
});
