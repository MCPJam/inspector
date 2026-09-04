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
