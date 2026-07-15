import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { HostFocusTabId } from "../../types";
import { HostFocusTabBar } from "../HostFocusTabBar";

describe("HostFocusTabBar", () => {
  it("uses a horizontal tablist for arrow-key navigation", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();

    render(<HostFocusTabBar tab="behavior" onTabChange={onTabChange} />);

    const list = screen.getByRole("tablist");
    expect(list).toHaveAttribute("aria-orientation", "horizontal");

    screen.getByRole("tab", { name: /^Agent$/ }).focus();
    await user.keyboard("{ArrowRight}");
    // With no `tabs` prop the bar renders the full static set, so Agent's
    // right neighbour is MCP Protocol (Agent → MCP Protocol → Apps → …).
    expect(onTabChange).toHaveBeenCalledWith(
      "protocol" satisfies HostFocusTabId,
    );

    onTabChange.mockClear();
    await user.keyboard("{ArrowLeft}");
    // Arrow-left from the first tab (Agent) wraps to the last tab (Computer).
    expect(onTabChange).toHaveBeenCalledWith(
      "computer" satisfies HostFocusTabId,
    );
  });
});
