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
  updateServerWithClientSecret: vi.fn(),
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
vi.mock("@/hooks/useProjects", () => ({
  useServerMutations: () => ({
    updateServerWithClientSecret: h.updateServerWithClientSecret,
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
  h.updateServerWithClientSecret.mockResolvedValue(undefined);
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

  it("keeps an unrecognized readiness distinguishable from needs_setup on the card", () => {
    h.setupStatus.value = {
      pluginVersionId: "pv_1",
      status: "ready",
      components: [
        {
          componentKey: "server:api",
          placement: "remote",
          authenticationPolicy: "on_install",
          readiness: "some_future_state",
        },
      ],
    };
    render(<PluginGroupCard plugin={plugin} />);
    const badge = screen.getByTestId("plugin-health-badge");
    // The label is deliberately generic (never claims readiness), so the raw
    // backend code has to reach the card some other way.
    expect(badge.textContent).toBe("Setup required");
    expect(badge.getAttribute("title")).toContain("some_future_state");

    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    expect(
      screen
        .getByTestId("plugin-component-readiness")
        .getAttribute("title"),
    ).toContain("some_future_state");
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
    // Fields the deployed backend does not return yet render NOTHING —
    // absence is semantic, never a placeholder.
    expect(detail.textContent).not.toContain("Agent Plugins");
    expect(screen.queryByTestId("plugin-component-configure")).toBeNull();
  });

  it("renders a dotted Agent Plugins name verbatim in the list card and detail", () => {
    h.version.value = {
      ...(h.version.value as Record<string, unknown>),
      schemaVersion: "1.0.0",
      servers: [
        {
          componentId: "c_1",
          componentKey: "server:com.acme.search",
          declaredName: "com.acme.search",
          placement: "remote",
          authenticationPolicy: "on_install",
          materializedServerId: "s_1",
          httpVariant: "sse",
        },
      ],
      skills: [
        {
          componentId: "c_2",
          componentKey: "skill:triage",
          declaredName: "triage",
          modelRef: "com.acme.tools/triage",
          materializedSkillId: "sk_1",
        },
      ],
    };
    h.setupStatus.value = {
      pluginVersionId: "pv_1",
      status: "ready",
      components: [
        {
          componentKey: "server:com.acme.search",
          placement: "remote",
          authenticationPolicy: "on_install",
          readiness: "ready",
        },
      ],
    };
    render(
      <PluginGroupCard
        plugin={{ ...plugin, name: "com.acme.tools", displayName: "" }}
      />,
    );
    // The list card title falls back to the dotted name, unsplit.
    expect(screen.getByText("com.acme.tools")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
    const detail = screen.getByTestId("plugin-group-card-detail");
    // Dotted component identities render whole in the detail view too.
    expect(detail.textContent).toContain("com.acme.search");
    expect(detail.textContent).toContain("com.acme.tools/triage");
    // New optional projection fields render verbatim when present.
    expect(detail.textContent).toContain("Agent Plugins 1.0.0");
    expect(detail.textContent).toContain("sse");
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

describe("PluginGroupCard — inline component setup", () => {
  /** Version whose one server carries requirement entries (post-deploy shape). */
  function versionWithRequirements(server: Record<string, unknown>) {
    return {
      ...(h.version.value as Record<string, unknown>),
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
    };
  }

  function expandCard() {
    render(<PluginGroupCard plugin={plugin} />);
    fireEvent.click(screen.getAllByRole("button", { expanded: false })[0]);
  }

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

  it("labels needs_setup truthfully and saves values through the credential-only write path", async () => {
    h.version.value = versionWithRequirements({
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
    expandCard();
    // Both the card rollup and the component chip use the same wording.
    expect(screen.getAllByText("Needs configuration").length).toBeGreaterThan(
      0,
    );

    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    // The bundle-declared literal is read-only with an override affordance,
    // not an editable input.
    expect(screen.getByText("production")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Override" })).toBeTruthy();
    expect(screen.queryByLabelText("Value for MODE")).toBeNull();
    // A template-supplied value is pre-configured: no input, no override —
    // the runtime resolves it at launch.
    expect(screen.getByText("Pre-configured")).toBeTruthy();
    expect(screen.queryByLabelText("Value for CONFIG_PATH")).toBeNull();

    fireEvent.change(screen.getByLabelText("Value for API_KEY"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.change(screen.getByLabelText("Value for X-Api-Key"), {
      target: { value: "abc" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-server-setup-save"));
    });

    // Credential-only payload: the server id plus values, never structural
    // fields (the backend rejects structural edits on plugin rows). The map
    // is COMPLETE per group — `updateServerWithClientSecret` REPLACES the
    // env/header map rather than merging, so the untouched literal and the
    // template must ride along or they are dropped from the runtime launch.
    expect(h.updateServerWithClientSecret).toHaveBeenCalledWith({
      serverId: "s_1",
      env: {
        API_KEY: "sk-test-123",
        MODE: "production",
        CONFIG_PATH: "${PLUGIN_ROOT}/data",
      },
      headers: { "X-Api-Key": "abc" },
    });
    // A successful save closes the editor; readiness stays whatever the
    // backend subscription says, never a client-side claim.
    expect(screen.queryByTestId("plugin-server-setup")).toBeNull();
  });

  it("sends the whole group's declared values when only one requirement is edited", async () => {
    // The regression this pins: `updateServerWithClientSecret` REPLACES the
    // env map (a new vault object is created from exactly this payload and
    // the row's pointer repointed at it), and connect-time resolution
    // prefers the vault map over the row's plaintext env. A partial map
    // therefore permanently drops the omitted names from the launch.
    h.version.value = versionWithRequirements({
      envRequirements: [
        { name: "API_KEY", required: true },
        { name: "MODE", required: false, value: "production" },
        {
          name: "DATA_DIR",
          hasTemplate: true,
          valueTemplate: "${PLUGIN_DATA}/cache",
        },
      ],
      headerRequirements: [{ name: "X-Api-Key", secret: true }],
    });
    expandCard();
    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    fireEvent.change(screen.getByLabelText("Value for API_KEY"), {
      target: { value: "sk-test-123" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-server-setup-save"));
    });

    const payload = h.updateServerWithClientSecret.mock.calls[0][0];
    expect(payload.env).toEqual({
      API_KEY: "sk-test-123",
      MODE: "production",
      DATA_DIR: "${PLUGIN_DATA}/cache",
    });
    // The header group was not touched, so its pointer is left alone
    // entirely rather than replaced with a map built from stale knowledge.
    expect(payload.headers).toBeUndefined();
  });

  it("overrides a bundle-declared literal only when the value actually changed", async () => {
    h.version.value = versionWithRequirements({
      envRequirements: [{ name: "MODE", required: false, value: "production" }],
    });
    expandCard();
    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    fireEvent.click(screen.getByRole("button", { name: "Override" }));

    // Overriding pre-fills the declared literal for editing…
    const input = screen.getByLabelText("Value for MODE") as HTMLInputElement;
    expect(input.value).toBe("production");
    // …and an unchanged override has nothing to save.
    expect(
      (screen.getByTestId("plugin-server-setup-save") as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    fireEvent.change(input, { target: { value: "staging" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("plugin-server-setup-save"));
    });
    expect(h.updateServerWithClientSecret).toHaveBeenCalledWith({
      serverId: "s_1",
      env: { MODE: "staging" },
    });
  });

  it("does not fire the credential mutation for a whitespace-only value", async () => {
    h.version.value = versionWithRequirements({
      envRequirements: [{ name: "API_KEY", required: true }],
    });
    expandCard();
    fireEvent.click(screen.getByTestId("plugin-component-configure"));
    fireEvent.change(screen.getByLabelText("Value for API_KEY"), {
      target: { value: "   " },
    });

    // Whitespace is not a value: there is nothing to save…
    const save = screen.getByTestId(
      "plugin-server-setup-save",
    ) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // …and forcing the click through writes nothing either.
    await act(async () => {
      fireEvent.click(save);
    });
    expect(h.updateServerWithClientSecret).not.toHaveBeenCalled();
    expect(screen.getByTestId("plugin-server-setup")).toBeTruthy();
  });

  it("keeps the editor open and surfaces the backend error when the save fails", async () => {
    h.updateServerWithClientSecret.mockRejectedValue(
      new Error("Structural edits to plugin servers are not allowed"),
    );
    h.version.value = versionWithRequirements({
      envRequirements: [{ name: "API_KEY", required: true }],
    });
    expandCard();
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

  it("offers no editor when the projection carries no requirement entries", () => {
    // The deployed backend does not project requirement entries yet: the
    // chip still tells the truth, but there is nothing to edit.
    expandCard();
    expect(screen.getAllByText("Needs configuration").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByTestId("plugin-component-configure")).toBeNull();
  });
});
