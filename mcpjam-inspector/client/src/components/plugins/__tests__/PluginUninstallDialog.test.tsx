import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ environments: false }));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flags.environments,
}));

import { PluginUninstallDialog } from "../PluginUninstallDialog";

function renderDialog() {
  return render(
    <PluginUninstallDialog
      open
      onOpenChange={() => {}}
      pluginLabel="Bits & Bolts"
      onConfirm={() => {}}
    />,
  );
}

describe("PluginUninstallDialog", () => {
  it("says nothing about environments while the environments UI is hidden", () => {
    flags.environments = false;
    renderDialog();
    expect(screen.getByText("Uninstall Bits & Bolts?")).toBeTruthy();
    expect(screen.queryByText(/environment/i)).toBeNull();
  });

  it("explains the pin rule to someone who can see environments", () => {
    flags.environments = true;
    renderDialog();
    expect(screen.getByText(/live environment still pins/)).toBeTruthy();
  });
});
