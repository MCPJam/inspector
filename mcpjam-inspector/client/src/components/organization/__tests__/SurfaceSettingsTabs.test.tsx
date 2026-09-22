import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SurfaceSettingsTabs } from "../surface/SurfaceSettingsTabs";

/**
 * The shared tab strip.
 *
 * Worth its own file because the reason this was extracted rather than copied
 * is an accessibility rule that is invisible in a screenshot: only the ACTIVE
 * tab's panel is mounted, so only the active tab may carry `aria-controls`.
 * A second hand-written copy would very plausibly point all three at their
 * panels and hand a screen reader two targets it cannot move to. Neither
 * section's own tests assert this, so it is asserted here.
 */

const TABS = [
  { id: "connections", label: "Connections", description: "Where turns land." },
  { id: "activity", label: "Activity", description: "What the agent did." },
] as const;

function renderStrip(
  activeTab: (typeof TABS)[number]["id"] = "connections",
  onTabChange = vi.fn()
) {
  render(
    <SurfaceSettingsTabs
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={onTabChange}
      idPrefix="demo-settings"
      ariaLabel="Demo agent settings"
    >
      <div data-testid="panel-body">body</div>
    </SurfaceSettingsTabs>
  );
  return onTabChange;
}

describe("SurfaceSettingsTabs", () => {
  it("points aria-controls only at the panel that is mounted", () => {
    renderStrip("connections");
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute(
      "aria-controls",
      "demo-settings-panel-connections"
    );
    // The inactive tab's panel does not exist, so the attribute must be absent
    // rather than dangling.
    expect(screen.getByRole("tab", { name: "Activity" })).not.toHaveAttribute(
      "aria-controls"
    );
    expect(document.getElementById("demo-settings-panel-activity")).toBeNull();
  });

  it("marks exactly one tab selected and labels the panel from it", () => {
    renderStrip("activity");
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Activity"
    );
    expect(screen.getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "demo-settings-tab-activity"
    );
  });

  it("names the tablist and shows the active tab's description", () => {
    renderStrip("activity");
    expect(
      screen.getByRole("tablist", { name: "Demo agent settings" })
    ).toBeInTheDocument();
    expect(screen.getByText("What the agent did.")).toBeInTheDocument();
    expect(screen.queryByText("Where turns land.")).not.toBeInTheDocument();
  });

  it("reports a click to its caller", async () => {
    const onTabChange = renderStrip("connections");
    await userEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(onTabChange).toHaveBeenCalledWith("activity");
  });
});
