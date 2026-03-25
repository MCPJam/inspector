import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyMcpToolCallingDiagram } from "../WhyMcpToolCallingDiagram";

describe("WhyMcpToolCallingDiagram", () => {
  it("visualizes the order flow from the code example", () => {
    render(<WhyMcpToolCallingDiagram />);
    expect(
      screen.getByText(/What.*s the status of order #4521/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/get_order_status\(order_id=/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/4521/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/shipped yesterday/i)).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /get_order_status/i }),
    ).toBeInTheDocument();
  });
});
