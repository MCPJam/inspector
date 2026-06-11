import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MCPJamMarkIndicator } from "../mcpjam-mark";

describe("MCPJamMarkIndicator", () => {
  it("renders three primary dots with the MCPJam wave classes", () => {
    const { getByTestId, container } = render(<MCPJamMarkIndicator />);

    const root = getByTestId("loading-indicator-mcpjam");
    expect(root).toHaveClass("mcpjam-mark-indicator");

    const dots = container.querySelectorAll(".mcpjam-mark-indicator__dot");
    expect(dots).toHaveLength(3);
    expect(dots[0]).toHaveClass("bg-primary", "mcpjam-mark-indicator__dot--1");
    expect(dots[1]).toHaveClass("bg-primary", "mcpjam-mark-indicator__dot--2");
    expect(dots[2]).toHaveClass("bg-primary", "mcpjam-mark-indicator__dot--3");
  });
});
