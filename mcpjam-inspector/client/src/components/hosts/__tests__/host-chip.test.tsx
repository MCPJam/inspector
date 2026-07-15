import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HostChip } from "../host-chip";

describe("HostChip", () => {
  it("renders client name with label styling", () => {
    render(<HostChip name="ChatGPT" hostId="host-1" />);
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.getByTitle("host-1")).toBeInTheDocument();
  });

  it("resolves logo for known built-in client names", () => {
    const { container } = render(<HostChip name="Claude" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBeTruthy();
  });

  it("renders stacked layout for column headers", () => {
    render(
      <HostChip
        name="MCPJam"
        hostId="host-1"
        layout="stack"
        size="sm"
      />,
    );
    expect(screen.getByText("MCPJam")).toHaveClass("text-[11px]");
    expect(screen.getByTitle("host-1")).not.toHaveClass("rounded-full");
  });

  it("shows initials fallback when no logo is available", () => {
    render(<HostChip name="Custom Host" layout="stack" />);
    expect(screen.getByText("Cu")).toBeInTheDocument();
  });
});
