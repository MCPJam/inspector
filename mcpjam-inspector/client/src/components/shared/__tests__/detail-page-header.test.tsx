import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DetailPageHeader } from "../detail-page-header";

describe("DetailPageHeader", () => {
  it("keeps view tabs on the same row as the title", () => {
    const onChange = vi.fn();
    render(
      <DetailPageHeader
        backLabel="Swarms"
        onBack={() => {}}
        title={<h1>Swarm abc</h1>}
        tabs={{
          value: "findings",
          options: [
            { value: "findings", label: "Findings" },
            { value: "insights", label: "Insights" },
          ],
          onChange,
          ariaLabel: "Swarm run view",
          indicatorId: "test-detail",
        }}
      />,
    );

    const title = screen.getByRole("heading", { name: "Swarm abc" });
    const findings = screen.getByRole("button", { name: "Findings" });
    const row = title.closest("div.flex.items-center.justify-between");
    expect(row).toBeTruthy();
    expect(row?.contains(findings)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(onChange).toHaveBeenCalledWith("insights");
  });

  it("makes the title, not the tab strip, absorb a long name", () => {
    // BB-202: a 200-char run name rendered "Sessions" as "Sess". jsdom has no
    // layout, so this pins the flex contract that decides which child gives.
    render(
      <DetailPageHeader
        backLabel="Swarms"
        onBack={() => {}}
        title={<h1 className="truncate">{"S".repeat(200)}</h1>}
        tabs={{
          value: "findings",
          options: [
            { value: "findings", label: "Findings" },
            { value: "insights", label: "Insights" },
            { value: "sessions", label: "Sessions" },
          ],
          onChange: vi.fn(),
          ariaLabel: "Swarm run view",
          indicatorId: "test-detail",
        }}
        actions={<button type="button">Run again</button>}
      />,
    );

    // These two classes ARE the fix. jsdom has no layout, so nothing here can
    // observe the clipping itself — asserting the contract is the only guard.
    const strip = screen.getByRole("navigation", { name: "Swarm run view" });
    expect(strip.className.split(/\s+/)).toContain("lg:shrink-0");

    const titleSlot = screen.getByRole("heading").parentElement;
    expect(titleSlot?.className.split(/\s+/)).toContain("min-w-0");

    // Below lg the strip must stay shrinkable and scrollable, or a narrow
    // viewport loses the tabs the strip is meant to scroll to.
    expect(strip.className.split(/\s+/)).toContain("shrink");
    expect(strip.className.split(/\s+/)).toContain("overflow-x-auto");
  });

  it("scrolls the newly active tab into view when the strip overflows", () => {
    const scrollIntoView = vi.fn();
    // jsdom has no layout, so scrollIntoView is undefined on elements.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    const tabs = {
      options: [
        { value: "findings", label: "Findings" },
        { value: "insights", label: "Insights" },
      ],
      onChange: vi.fn(),
      ariaLabel: "Swarm run view",
      indicatorId: "test-scroll",
    };

    const { rerender } = render(
      <DetailPageHeader
        backLabel="Swarms"
        onBack={() => {}}
        title={<h1>Swarm abc</h1>}
        tabs={{ ...tabs, value: "findings" }}
      />,
    );
    scrollIntoView.mockClear();

    rerender(
      <DetailPageHeader
        backLabel="Swarms"
        onBack={() => {}}
        title={<h1>Swarm abc</h1>}
        tabs={{ ...tabs, value: "insights" }}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole("button", { name: "Insights" }),
    );
  });
});
