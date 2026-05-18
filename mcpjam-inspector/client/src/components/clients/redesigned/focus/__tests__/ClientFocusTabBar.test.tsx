import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostFocusTabId } from "../../types";
import { HostFocusTabBar } from "../HostFocusTabBar";

const emptyIssues = {
  behavior: 0,
  protocol: 0,
  apps: 0,
  servers: 0,
  appearance: 0,
} as const;

describe("HostFocusTabBar", () => {
  it("uses a horizontal tablist for arrow-key navigation", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();

    render(
      <HostFocusTabBar
        tab="behavior"
        onTabChange={onTabChange}
        issuesByTab={emptyIssues}
      />,
    );

    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "horizontal");

    screen.getByRole("tab", { name: /^Agent$/ }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenCalledWith("protocol");

    onTabChange.mockClear();
    await user.keyboard("{ArrowLeft}");
    // Arrow-left from the first tab (Agent) wraps to the last tab,
    // which is Appearance after the General tab was removed.
    expect(onTabChange).toHaveBeenCalledWith("appearance" satisfies HostFocusTabId);
  });
});
