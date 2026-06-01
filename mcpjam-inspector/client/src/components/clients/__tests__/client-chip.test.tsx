import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientChip } from "../client-chip";

describe("ClientChip", () => {
  it("renders client name with label styling", () => {
    render(<ClientChip name="ChatGPT" hostId="host-1" />);
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(screen.getByTitle("host-1")).toBeInTheDocument();
  });

  it("resolves logo for known built-in client names", () => {
    const { container } = render(<ClientChip name="Claude" />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBeTruthy();
  });
});
