/**
 * Installed-plugins group on Connect: renders nothing at all for a project
 * with no plugins, and renders Agent Plugins dotted names (`com.acme.tools`)
 * verbatim — nothing in the list path may split or slug the name.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@/lib/plugins/plugin-api-types";

const h = vi.hoisted(() => ({
  plugins: { value: undefined as unknown },
}));

vi.mock("@/hooks/usePluginImportApi", () => ({
  useProjectPlugins: () => h.plugins.value,
  // Hooks the group cards inside the section subscribe with.
  usePluginVersion: () => undefined,
  usePluginSetupStatus: () => undefined,
  useProjectPlugin: () => undefined,
  usePluginManagementActions: () => ({
    setEnabled: vi.fn(),
    activateVersion: vi.fn(),
    softDeletePlugin: vi.fn(),
    restorePlugin: vi.fn(),
  }),
}));
vi.mock("@/hooks/useProjects", () => ({
  useServerMutations: () => ({ updateServerWithClientSecret: vi.fn() }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));

import { PluginsSection } from "../PluginsSection";

function summary(overrides: Partial<PluginSummary>): PluginSummary {
  return {
    pluginId: "pl_1",
    projectId: "p_1",
    name: "demo",
    displayName: "Demo",
    enabled: true,
    activeVersionId: "pv_1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  h.plugins.value = undefined;
});

describe("PluginsSection", () => {
  it("renders nothing at all while loading or when the project has no plugins", () => {
    const { container, rerender } = render(
      <PluginsSection projectId="p_1" />,
    );
    expect(container.firstChild).toBeNull();

    h.plugins.value = [];
    rerender(<PluginsSection projectId="p_1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a dotted Agent Plugins name verbatim in the main list", () => {
    h.plugins.value = [
      summary({ name: "com.acme.tools", displayName: "" }),
    ];
    render(<PluginsSection projectId="p_1" />);
    expect(screen.getByTestId("plugins-section")).toBeTruthy();
    // The full dotted name, unsplit — no slug/prefix derivation anywhere in
    // the list path.
    expect(screen.getByText("com.acme.tools")).toBeTruthy();
  });
});
