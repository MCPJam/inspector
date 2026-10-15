/**
 * The Plugin section of a plugin server's Settings (and a skills-only
 * plugin's skill detail): versions + Activate, per-component setup,
 * Enable/Disable and Uninstall — admin-only lifecycle disabled with the
 * reason for members.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  detail: { value: undefined as unknown },
  version: { value: undefined as unknown },
  setupStatus: { value: undefined as unknown },
  activeRows: { value: [] as unknown[] },
  canManage: { value: true as boolean | undefined },
  setEnabled: vi.fn(),
  activateVersion: vi.fn(),
  softDeletePlugin: vi.fn(),
  restorePlugin: vi.fn(),
  updateServerWithClientSecret: vi.fn(),
  track: vi.fn(),
  toastError: vi.fn(),
  requestOnboarding: vi.fn(),
  navigateApp: vi.fn(),
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugin: () => h.detail.value,
  usePluginVersion: () => h.version.value,
  usePluginSetupStatus: () => h.setupStatus.value,
  usePluginManagementActions: () => ({
    setEnabled: h.setEnabled,
    activateVersion: h.activateVersion,
    softDeletePlugin: h.softDeletePlugin,
    restorePlugin: h.restorePlugin,
  }),
}));
vi.mock("@/hooks/useActivePlugins", () => ({
  useActivePlugins: () => ({
    plugins: h.activeRows.value,
    activePlugins: [],
    activeServers: [],
    isLoading: false,
  }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useServerMutations: () => ({
    updateServerWithClientSecret: h.updateServerWithClientSecret,
  }),
  useCanManageProjectClients: () => ({
    canManage: h.canManage.value === true,
    isLoading: h.canManage.value === undefined,
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/lib/analytics", () => ({ track: h.track }));
vi.mock("@/lib/toast", () => ({ toast: { error: h.toastError } }));
vi.mock("@/lib/plugin-onboarding-intent", () => ({
  usePluginOnboardingIntentStore: {
    getState: () => ({ request: h.requestOnboarding }),
  },
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: h.navigateApp,
  routePaths: { playground: "/playground" },
}));

import { PluginSettingsSection } from "../PluginSettingsSection";

function baseVersion(server: Record<string, unknown> = {}) {
  return {
    pluginVersionId: "pv_1",
    pluginId: "pl_1",
    bundleHash: "aa11bb22cc33dd44",
    declaredVersion: "1.2.0",
    status: "ready",
    manifestHash: "ff",
    componentCounts: {
      skills: 0,
      servers: 1,
      apps: 0,
      assets: 0,
      unsupported: 0,
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
        ...server,
      },
    ],
    skills: [],
  };
}

function renderSection(
  props: Partial<Parameters<typeof PluginSettingsSection>[0]> = {},
) {
  return render(
    <PluginSettingsSection projectId="p_1" pluginId="pl_1" {...props} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.updateServerWithClientSecret.mockResolvedValue(undefined);
  h.setEnabled.mockResolvedValue(undefined);
  h.activateVersion.mockResolvedValue(undefined);
  h.softDeletePlugin.mockResolvedValue(undefined);
  h.canManage.value = true;
  h.activeRows.value = [
    {
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
      name: "demo",
      displayName: "Demo",
      status: "active",
      servers: [],
      skills: [],
    },
  ];
  h.detail.value = {
    pluginId: "pl_1",
    projectId: "p_1",
    name: "demo",
    displayName: "Demo",
    enabled: true,
    activeVersionId: "pv_1",
    createdAt: 1,
    updatedAt: 1,
    versions: [
      {
        pluginVersionId: "pv_2",
        pluginId: "pl_1",
        bundleHash: "bb22cc33dd44ee55",
        declaredVersion: "1.3.0",
        status: "ready",
        componentCounts: {
          skills: 0,
          servers: 1,
          apps: 0,
          assets: 0,
          unsupported: 0,
        },
        createdAt: 2,
      },
      {
        pluginVersionId: "pv_1",
        pluginId: "pl_1",
        bundleHash: "aa11bb22cc33dd44",
        declaredVersion: "1.2.0",
        status: "ready",
        componentCounts: {
          skills: 0,
          servers: 1,
          apps: 0,
          assets: 0,
          unsupported: 0,
        },
        createdAt: 1,
      },
    ],
  };
  h.version.value = baseVersion();
  h.setupStatus.value = {
    pluginVersionId: "pv_1",
    status: "ready",
    components: [
      {
        componentKey: "server:api",
        placement: "remote",
        authenticationPolicy: "on_install",
        readiness: "ready",
      },
    ],
  };
});

describe("PluginSettingsSection", () => {
  it("shows whether chats run the plugin and its active version", () => {
    renderSection();
    expect(screen.getByTestId("plugin-status").textContent).toContain("Active");
    expect(screen.getByText("Demo")).toBeTruthy();
    // The status, and the badge on the active version.
    expect(screen.getAllByText("Active")).toHaveLength(2);
    expect(screen.getByText("aa11bb22cc33")).toBeTruthy();
  });

  it("activates another version, saying it changes chats from the next message", async () => {
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /1 other version/ }));
    expect(
      screen.getByText(/changes what chats run from the next message/),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Activate bb22cc33dd44" }),
      );
    });
    expect(h.activateVersion).toHaveBeenCalledWith("pl_1", "pv_2");
  });

  it("lists an install-only plugin's ready versions to activate, unfolded", async () => {
    h.detail.value = {
      ...(h.detail.value as Record<string, unknown>),
      activeVersionId: undefined,
    };
    h.version.value = undefined;
    h.activeRows.value = [
      {
        pluginId: "pl_1",
        pluginVersionId: null,
        name: "demo",
        displayName: "Demo",
        status: "skipped",
        reason: "no_active_version",
        servers: [],
        skills: [],
      },
    ];
    renderSection();
    expect(screen.getByTestId("plugin-status").textContent).toBe(
      "Not activated",
    );
    expect(
      screen.getByText(/No version is active yet\. Activate one/),
    ).toBeTruthy();
    // Nothing to fold under: the ready versions are listed directly.
    expect(screen.queryByRole("button", { name: /other version/ })).toBeNull();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Activate aa11bb22cc33" }),
      );
    });
    expect(h.activateVersion).toHaveBeenCalledWith("pl_1", "pv_1");
    expect(
      screen.getByRole("button", { name: "Activate bb22cc33dd44" }),
    ).toBeTruthy();
    // Uninstall is here too.
    expect(
      screen.getByRole("button", { name: /Uninstall plugin/ }),
    ).toBeTruthy();
  });

  it("disables and re-enables through the lifecycle mutation", async () => {
    renderSection();
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-toggle-enabled"));
    });
    expect(h.setEnabled).toHaveBeenCalledWith("pl_1", false);

    h.detail.value = { ...(h.detail.value as object), enabled: false };
    h.activeRows.value = [
      {
        ...(h.activeRows.value[0] as object),
        status: "skipped",
        reason: "disabled",
      },
    ];
    renderSection();
    expect(screen.getAllByTestId("plugin-status")[1]?.textContent).toContain(
      "Disabled",
    );
    await act(async () => {
      fireEvent.click(screen.getAllByTestId("plugin-toggle-enabled")[1]!);
    });
    expect(h.setEnabled).toHaveBeenLastCalledWith("pl_1", true);
  });

  it("uninstalls after the confirm and reports it", async () => {
    const onUninstalled = vi.fn();
    renderSection({ onUninstalled });
    fireEvent.click(screen.getByTestId("plugin-uninstall"));
    expect(screen.getByText("Uninstall Demo?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    });
    expect(h.softDeletePlugin).toHaveBeenCalledWith("pl_1");
    expect(onUninstalled).toHaveBeenCalled();
  });

  it("surfaces the backend's environment-pin conflict when uninstall is blocked", async () => {
    h.softDeletePlugin.mockRejectedValue(
      new Error('still pinned by environment "Staging"'),
    );
    const onUninstalled = vi.fn();
    renderSection({ onUninstalled });
    fireEvent.click(screen.getByTestId("plugin-uninstall"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    });
    expect(h.toastError).toHaveBeenCalledWith(
      'still pinned by environment "Staging"',
    );
    expect(onUninstalled).not.toHaveBeenCalled();
  });

  it("gives a member the lifecycle actions disabled, with the reason", () => {
    h.canManage.value = false;
    renderSection();
    expect(
      (screen.getByTestId("plugin-toggle-enabled") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("plugin-uninstall") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /1 other version/ }));
    expect(
      (
        screen.getByRole("button", {
          name: "Activate bb22cc33dd44",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByTestId("plugin-admin-only-reason").textContent).toBe(
      "Only project admins can activate, disable or uninstall plugins.",
    );
  });

  it("does not show the reason while membership is still loading", () => {
    h.canManage.value = undefined;
    renderSection();
    expect(
      (screen.getByTestId("plugin-uninstall") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("plugin-admin-only-reason")).toBeNull();
  });

  it("offers the plugin's onboarding when its version declares one", () => {
    h.version.value = {
      ...baseVersion(),
      onboarding: { componentId: "c_9", modelRef: "demo/onboarding" },
    };
    renderSection();
    fireEvent.click(screen.getByTestId("plugin-onboarding-setup"));
    expect(h.requestOnboarding).toHaveBeenCalledWith({
      projectId: "p_1",
      serverIds: ["s_1"],
      pluginName: "Demo",
      conversation: "new",
    });
    expect(h.navigateApp).toHaveBeenCalledWith("/playground");
  });
});

describe("PluginSettingsSection — component setup", () => {
  beforeEach(() => {
    h.setupStatus.value = {
      pluginVersionId: "pv_1",
      status: "ready",
      components: [
        {
          componentKey: "server:api",
          placement: "remote",
          authenticationPolicy: "on_install",
          readiness: "needs_setup",
        },
      ],
    };
  });

  it("labels needs_setup and saves the whole group through the credential-only write path", async () => {
    h.version.value = baseVersion({
      envRequirements: [
        { name: "API_KEY", required: true },
        { name: "MODE", required: false, value: "production" },
        {
          name: "CONFIG_PATH",
          hasTemplate: true,
          valueTemplate: "${PLUGIN_ROOT}/data",
        },
      ],
      headerRequirements: [{ name: "X-Api-Key", secret: true }],
    });
    renderSection();
    expect(screen.getByTestId("plugin-component-readiness").textContent).toBe(
      "Needs configuration",
    );

    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    fireEvent.change(screen.getByLabelText("Value for API_KEY"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.change(screen.getByLabelText("Value for X-Api-Key"), {
      target: { value: "abc" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-server-setup-save"));
    });

    // REPLACE semantics: the untouched literal and the template ride along.
    expect(h.updateServerWithClientSecret).toHaveBeenCalledWith({
      serverId: "s_1",
      env: {
        API_KEY: "sk-test-123",
        MODE: "production",
        CONFIG_PATH: "${PLUGIN_ROOT}/data",
      },
      headers: { "X-Api-Key": "abc" },
    });
    expect(screen.queryByTestId("plugin-server-setup")).toBeNull();
  });

  it("keeps the editor open and surfaces the backend error when the save fails", async () => {
    h.updateServerWithClientSecret.mockRejectedValue(
      new Error("Structural edits to plugin servers are not allowed"),
    );
    h.version.value = baseVersion({
      envRequirements: [{ name: "API_KEY", required: true }],
    });
    renderSection();
    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    fireEvent.change(screen.getByLabelText("Value for API_KEY"), {
      target: { value: "sk-test-123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-server-setup-save"));
    });
    expect(h.toastError).toHaveBeenCalledWith(
      "Structural edits to plugin servers are not allowed",
    );
    expect(screen.getByTestId("plugin-server-setup")).toBeTruthy();
  });

  it("is open to members: setup values are not admin-only", () => {
    h.canManage.value = false;
    h.version.value = baseVersion({
      envRequirements: [{ name: "API_KEY", required: true }],
    });
    renderSection();
    expect(
      (screen.getByTestId("plugin-component-configure") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("offers no editor when the projection carries no requirement entries", () => {
    renderSection();
    expect(screen.getByTestId("plugin-component-readiness").textContent).toBe(
      "Needs configuration",
    );
    expect(screen.queryByTestId("plugin-component-configure")).toBeNull();
  });
});
