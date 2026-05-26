import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostFocusTabId } from "../../types";
import { ClientFocusTabBar } from "../ClientFocusTabBar";

describe("ClientFocusTabBar", () => {
  it("uses a horizontal tablist for arrow-key navigation", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();

    render(
      <ClientFocusTabBar tab="behavior" onTabChange={onTabChange} />,
    );

    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "horizontal");

    screen.getByRole("tab", { name: /^Agent$/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenCalledWith("protocol");

    onTabChange.mockClear();
    await user.keyboard("{ArrowLeft}");
    // Arrow-left from the first tab (Agent) wraps to the last tab.
    // After the project-scoped server config rollout removed the
    // per-host Servers tab, the last visible tab is Apps Extension.
    expect(onTabChange).toHaveBeenCalledWith("apps" satisfies HostFocusTabId);
  });
});
