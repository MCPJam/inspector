import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CollapsedPanelStrip } from "../collapsed-panel-strip";

describe("CollapsedPanelStrip", () => {
  it("shows its label and opens the panel", () => {
    const onOpen = vi.fn();
    render(
      <CollapsedPanelStrip
        onOpen={onOpen}
        tooltipText="Show logs"
        label="Logs"
      />
    );
    const button = screen.getByRole("button", { name: "Show logs" });
    expect(button).toHaveTextContent("Logs");
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders only the icon without a label", () => {
    render(<CollapsedPanelStrip onOpen={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Show panel" })).toHaveTextContent(
      ""
    );
  });
});
