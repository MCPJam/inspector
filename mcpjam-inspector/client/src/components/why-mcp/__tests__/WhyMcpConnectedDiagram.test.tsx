import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyMcpConnectedDiagram } from "../WhyMcpConnectedDiagram";

describe("WhyMcpConnectedDiagram", () => {
  it("renders connected label and core nodes", () => {
    render(<WhyMcpConnectedDiagram />);
    expect(screen.getByText("connected via MCP")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("Services")).toBeInTheDocument();
  });
});
