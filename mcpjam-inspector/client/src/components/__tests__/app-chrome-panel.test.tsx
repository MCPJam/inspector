import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { isMobile } = vi.hoisted(() => ({ isMobile: { current: false } }));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: isMobile.current }),
}));

import { AppChromePanel } from "../app-chrome-panel";

/**
 * The inset panel's rounded top edge and shadow are only correct with the top
 * bar above them; without the bar they would cut into the top of the viewport
 * and read as a rendering bug. So the rule is worth pinning rather than
 * inferring from the class string.
 */
describe("AppChromePanel", () => {
  const panelClasses = (headerHidden: boolean, mobile: boolean) => {
    isMobile.current = mobile;
    render(
      <AppChromePanel headerHidden={headerHidden}>
        <span>content</span>
      </AppChromePanel>
    );
    return screen.getByTestId("app-chrome-panel").className;
  };

  it("insets itself when the desktop header is showing", () => {
    const cls = panelClasses(false, false);
    expect(cls).toContain("rounded-t-2xl");
    expect(cls).toContain("shadow-[0_2px_3px_#00000033]");
  });

  it("goes flush when the desktop header is hidden", () => {
    const cls = panelClasses(true, false);
    expect(cls).not.toContain("rounded-t-2xl");
    expect(cls).not.toContain("shadow-[0_2px_3px_#00000033]");
  });

  it("stays inset on mobile even with the header marked hidden", () => {
    // `AppChromeHeader` renders on mobile regardless, so the bar IS there.
    const cls = panelClasses(true, true);
    expect(cls).toContain("rounded-t-2xl");
    expect(cls).toContain("shadow-[0_2px_3px_#00000033]");
  });

  it("always paints the working surface and renders its children", () => {
    isMobile.current = false;
    render(
      <AppChromePanel headerHidden>
        <span>page body</span>
      </AppChromePanel>
    );
    const panel = screen.getByTestId("app-chrome-panel");
    expect(panel.className).toContain("bg-background");
    expect(screen.getByText("page body")).toBeVisible();
  });
});
