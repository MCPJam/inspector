import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyMcpNxMDiagram } from "../WhyMcpNxMDiagram";

describe("WhyMcpNxMDiagram", () => {
  it("renders comparison panels and hub", () => {
    render(<WhyMcpNxMDiagram />);
    expect(screen.getByText("Without MCP")).toBeInTheDocument();
    expect(screen.getByText("With MCP")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /Without MCP: each AI host is fully meshed/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /With MCP: each host and tool connects once through the hub/,
      }),
    ).toBeInTheDocument();
  });
});
