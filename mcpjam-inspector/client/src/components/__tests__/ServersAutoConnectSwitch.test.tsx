import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AUTO_CONNECT_SERVERS_KEY } from "@/stores/preferences/preferences-store";
import { ServersAutoConnectSwitch } from "../ServersAutoConnectSwitch";

function renderSwitch({
  disabled = false,
  canManage = true,
  onEnrollmentChange = vi.fn(),
}: {
  disabled?: boolean;
  canManage?: boolean;
  onEnrollmentChange?: (next: boolean) => void | Promise<void>;
} = {}) {
  return render(
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <ServersAutoConnectSwitch
        disabled={disabled}
        canManage={canManage}
        onEnrollmentChange={onEnrollmentChange}
      />
    </PreferencesStoreProvider>,
  );
}

describe("ServersAutoConnectSwitch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to on, matching auto-connect preference", () => {
    renderSwitch();
    expect(
      screen.getByRole("switch", { name: "Auto-connect project servers" }),
    ).toHaveAttribute("data-state", "checked");
  });

  it("writes autoConnectServersEnabled when toggled off", async () => {
    const user = userEvent.setup();
    const onEnrollmentChange = vi.fn();
    renderSwitch({ onEnrollmentChange });

    await user.click(
      screen.getByRole("switch", { name: "Auto-connect project servers" }),
    );

    expect(localStorage.getItem(AUTO_CONNECT_SERVERS_KEY)).toBe("false");
    expect(onEnrollmentChange).toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("switch", { name: "Auto-connect project servers" }),
    ).toHaveAttribute("data-state", "unchecked");
  });

  it("hydrates off from localStorage so a prior OFF is honored", () => {
    localStorage.setItem(AUTO_CONNECT_SERVERS_KEY, "false");
    renderSwitch();
    expect(
      screen.getByRole("switch", { name: "Auto-connect project servers" }),
    ).toHaveAttribute("data-state", "unchecked");
  });
});
