import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AUTO_CONNECT_SERVERS_KEY } from "@/stores/preferences/preferences-store";
import { ServersAutoConnectSwitch } from "../ServersAutoConnectSwitch";

const SWITCH_NAME = "Auto-connect servers on this device";

function renderSwitch(onToggled?: (next: boolean) => void) {
  return render(
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <ServersAutoConnectSwitch onToggled={onToggled} />
    </PreferencesStoreProvider>,
  );
}

describe("ServersAutoConnectSwitch", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to on, matching the auto-connect preference", () => {
    renderSwitch();
    expect(screen.getByRole("switch", { name: SWITCH_NAME })).toHaveAttribute(
      "data-state",
      "checked",
    );
  });

  it("is never disabled — it is a personal setting, not an admin one", () => {
    renderSwitch();
    expect(
      screen.getByRole("switch", { name: SWITCH_NAME }),
    ).not.toBeDisabled();
  });

  it("writes autoConnectServersEnabled=false when toggled off", async () => {
    const user = userEvent.setup();
    const onToggled = vi.fn();
    renderSwitch(onToggled);

    await user.click(screen.getByRole("switch", { name: SWITCH_NAME }));

    expect(localStorage.getItem(AUTO_CONNECT_SERVERS_KEY)).toBe("false");
    expect(onToggled).toHaveBeenCalledWith(false);
    expect(screen.getByRole("switch", { name: SWITCH_NAME })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("hydrates off from localStorage and writes true when toggled back on", async () => {
    localStorage.setItem(AUTO_CONNECT_SERVERS_KEY, "false");
    const user = userEvent.setup();
    const onToggled = vi.fn();
    renderSwitch(onToggled);
    expect(screen.getByRole("switch", { name: SWITCH_NAME })).toHaveAttribute(
      "data-state",
      "unchecked",
    );

    await user.click(screen.getByRole("switch", { name: SWITCH_NAME }));

    expect(localStorage.getItem(AUTO_CONNECT_SERVERS_KEY)).toBe("true");
    expect(onToggled).toHaveBeenCalledWith(true);
  });
});
