import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InspectorPaneHeader } from "@/components/ui/inspector-pane-header";

type Tab = "one" | "two" | "three";

function Harness({ onTabChange }: { onTabChange?: (tab: Tab) => void }) {
  const [active, setActive] = useState<Tab>("one");
  return (
    <InspectorPaneHeader<Tab>
      ariaLabel="Example views"
      tabs={[
        { id: "one", label: "One", count: 3, countTitle: "Three things" },
        { id: "two", label: "Two" },
        { id: "three", label: "Three", count: "5+" },
      ]}
      activeTab={active}
      onTabChange={(tab) => {
        setActive(tab);
        onTabChange?.(tab);
      }}
      secondaryActions={<button type="button">Refresh</button>}
      primaryAction={<button type="button">Run</button>}
    />
  );
}

describe("InspectorPaneHeader", () => {
  it("renders tabs with counts and marks the active one", () => {
    render(<Harness />);
    const list = screen.getByRole("tablist", { name: "Example views" });
    expect(list).toBeInTheDocument();
    const one = screen.getByRole("tab", { name: /One/ });
    expect(one).toHaveAttribute("aria-selected", "true");
    expect(one).toHaveAttribute("tabindex", "0");
    expect(screen.getByTitle("Three things")).toHaveTextContent("3");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByRole("tab", { name: /Three/ })).toHaveTextContent("5+");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  it("selects a tab on click", () => {
    const onTabChange = vi.fn();
    render(<Harness onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Two" }));
    expect(onTabChange).toHaveBeenCalledWith("two");
    expect(screen.getByRole("tab", { name: "Two" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("moves selection and focus with the arrow, Home and End keys", () => {
    render(<Harness />);
    const one = screen.getByRole("tab", { name: /One/ });
    one.focus();

    fireEvent.keyDown(one, { key: "ArrowLeft" });
    const three = screen.getByRole("tab", { name: /Three/ });
    expect(three).toHaveAttribute("aria-selected", "true");
    expect(three).toHaveFocus();

    fireEvent.keyDown(three, { key: "ArrowRight" });
    expect(one).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(one, { key: "End" });
    expect(three).toHaveFocus();

    fireEvent.keyDown(three, { key: "Home" });
    expect(one).toHaveFocus();
  });
});
