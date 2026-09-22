/**
 * Playground plugin chips + unavailable-component preflight (INS-4).
 *
 * The rule under test is honesty: a pinned version the backend refuses to run
 * is REPORTED, never hidden and never rendered as a runnable chip — including
 * (especially) when the environment failed to resolve because of it, which is
 * the only moment the user has no other way to find out.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnvironmentRow, mockRuntimePreview } = vi.hoisted(() => ({
  mockEnvironmentRow: { value: undefined as unknown },
  mockRuntimePreview: { value: undefined as unknown },
}));

vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironment: () => mockEnvironmentRow.value,
}));
vi.mock("@/hooks/usePluginImportApi", () => ({
  usePluginRuntimePreview: () => mockRuntimePreview.value,
}));

import { PlaygroundPluginSelector } from "../PlaygroundPluginSelector";

const PINNED = [
  { pluginId: "pl_1", pluginVersionId: "pv_1", name: "docs", enabled: true },
  { pluginId: "pl_2", pluginVersionId: "pv_2", name: "linear", enabled: false },
];

function renderSelector(props: Record<string, unknown> = {}) {
  const onTogglePlugin = vi.fn();
  const onResetPlugins = vi.fn();
  render(
    <PlaygroundPluginSelector
      projectId="proj_1"
      environmentId="env_1"
      plugins={PINNED}
      hasExplicitOverride={false}
      onTogglePlugin={onTogglePlugin}
      onResetPlugins={onResetPlugins}
      {...props}
    />,
  );
  return { onTogglePlugin, onResetPlugins };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnvironmentRow.value = {
    environmentId: "env_1",
    pluginVersionIds: ["pv_1", "pv_2"],
  };
  mockRuntimePreview.value = {
    pluginVersions: [],
    effectiveServerIds: [],
    pluginSkills: [],
    unavailableComponents: [],
  };
});

describe("PlaygroundPluginSelector", () => {
  it("renders nothing when the environment pins no plugins", () => {
    mockEnvironmentRow.value = { environmentId: "env_1" };
    renderSelector({ plugins: [] });
    expect(screen.queryByTestId("playground-plugins")).toBeNull();
  });

  it("reflects the enable state and reports a toggle", () => {
    const { onTogglePlugin } = renderSelector();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0].getAttribute("data-state")).toBe("checked");
    expect(boxes[1].getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(boxes[0]);
    expect(onTogglePlugin).toHaveBeenCalledWith("pv_1", false);
  });

  it("offers the reset only once the selection differs from the environment", () => {
    renderSelector();
    expect(screen.queryByTestId("playground-plugins-reset")).toBeNull();

    const { onResetPlugins } = renderSelector({ hasExplicitOverride: true });
    fireEvent.click(screen.getByTestId("playground-plugins-reset"));
    expect(onResetPlugins).toHaveBeenCalled();
  });

  it("names the unavailable version and why it cannot run", () => {
    mockRuntimePreview.value = {
      pluginVersions: [
        {
          pluginId: "pl_2",
          pluginVersionId: "pv_2",
          name: "linear",
          bundleHash: "h",
        },
      ],
      effectiveServerIds: [],
      pluginSkills: [],
      unavailableComponents: [{ pluginVersionId: "pv_2", reason: "disabled" }],
    };
    renderSelector();
    const preflight = screen.getByTestId("playground-plugins-unavailable");
    expect(preflight.textContent).toContain("1 of 2 pinned plugins");
    expect(preflight.textContent).toContain("Disabled");
    expect(preflight.textContent).toContain("linear");
  });

  it("still reports the culprit when the environment failed to resolve", () => {
    // No resolved pins to render as chips — the preview call that produces them
    // is exactly what the unavailable version made fail.
    mockEnvironmentRow.value = {
      environmentId: "env_1",
      pluginVersionIds: ["pv_1", "pv_uninstalled"],
    };
    mockRuntimePreview.value = {
      pluginVersions: [],
      effectiveServerIds: [],
      pluginSkills: [],
      unavailableComponents: [
        { pluginVersionId: "pv_uninstalled", reason: "uninstalled" },
      ],
    };
    renderSelector({ plugins: [] });
    const preflight = screen.getByTestId("playground-plugins-unavailable");
    expect(preflight.textContent).toContain("Uninstalled");
    // No name is knowable for a version the backend would not resolve; the
    // short id is what we actually have.
    expect(preflight.textContent).toContain("pv_uninstall");
    expect(screen.queryByTestId("playground-plugin-chips")).toBeNull();
  });

  it("reports an unknown reason rather than implying the version is usable", () => {
    mockRuntimePreview.value = {
      pluginVersions: [],
      effectiveServerIds: [],
      pluginSkills: [],
      unavailableComponents: [
        { pluginVersionId: "pv_1", reason: "quarantined_by_future_backend" },
      ],
    };
    renderSelector();
    expect(
      screen.getByTestId("playground-plugins-unavailable").textContent,
    ).toContain("quarantined_by_future_backend");
  });
});
