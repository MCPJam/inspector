import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WhyMcpProblemDiagram } from "../WhyMcpProblemDiagram";

describe("WhyMcpProblemDiagram", () => {
  it("renders the LLM node and external systems", () => {
    render(<WhyMcpProblemDiagram />);
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("Database")).toBeInTheDocument();
    expect(screen.getByText("APIs")).toBeInTheDocument();
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Services")).toBeInTheDocument();
  });
});
