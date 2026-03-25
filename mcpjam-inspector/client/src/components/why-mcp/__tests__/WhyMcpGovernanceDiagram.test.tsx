import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyMcpGovernanceDiagram } from "../WhyMcpGovernanceDiagram";

describe("WhyMcpGovernanceDiagram", () => {
  it("shows agent, policy gate, tool labels, and integration caption line", () => {
    render(<WhyMcpGovernanceDiagram />);
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("Policy")).toBeInTheDocument();
    expect(screen.getByText("allow · audit · revoke")).toBeInTheDocument();
    expect(screen.getByText("DB")).toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    expect(screen.getByText("Git")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: /Governance flow/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Tools and data")).toBeInTheDocument();
  });
});
