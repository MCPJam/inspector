import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FocusTabBar, type FocusTabDef } from "../FocusTabBar";

type ServerTab = "config" | "overview" | "history";

const TABS: ReadonlyArray<FocusTabDef<ServerTab>> = [
  { id: "config", label: "Config" },
  { id: "overview", label: "Overview" },
  { id: "history", label: "History" },
];

describe("FocusTabBar", () => {
  it("marks the active tab and reports clicks with the tab id", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn<(next: ServerTab) => void>();
    render(
      <FocusTabBar tab="overview" onTabChange={onTabChange} tabs={TABS} />,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
      "aria-selected",
      "false",
    );

    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(onTabChange).toHaveBeenCalledWith("history");
  });

  it("wraps arrow-key navigation at both ends", async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn<(next: ServerTab) => void>();
    const { rerender } = render(
      <FocusTabBar tab="history" onTabChange={onTabChange} tabs={TABS} />,
    );

    screen.getByRole("tab", { name: "History" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(onTabChange).toHaveBeenLastCalledWith("config");

    rerender(
      <FocusTabBar tab="config" onTabChange={onTabChange} tabs={TABS} />,
    );
    await user.keyboard("{ArrowLeft}");
    expect(onTabChange).toHaveBeenLastCalledWith("history");
  });
});
