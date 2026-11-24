import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { EvaluatorKindBadge, OwaspTag } from "../evaluator-kind-badge";

describe("EvaluatorKindBadge", () => {
  it.each([
    ["assertions", "Assertions"],
    ["judge", "Judge prompt"],
    ["decision", "Decision questions"],
    ["code", "Code"],
  ] as const)("labels the %s method", (method, label) => {
    renderWithProviders(<EvaluatorKindBadge method={method} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    ["library", "Library"],
    ["library-copy", "Library copy"],
    ["github", "From GitHub"],
  ] as const)("labels the %s origin", (origin, label) => {
    renderWithProviders(<EvaluatorKindBadge origin={origin} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("OwaspTag", () => {
  it("joins several ids and names the list for screen readers", () => {
    renderWithProviders(<OwaspTag ids={["MCP01", "MCP10"]} />);
    const prefix = screen.getByText("OWASP MCP Top 10:");
    expect(prefix).toHaveClass("sr-only");
    expect(prefix.parentElement).toHaveTextContent(
      "OWASP MCP Top 10: MCP01 · MCP10",
    );
  });

  it("renders nothing without ids", () => {
    const { container } = renderWithProviders(<OwaspTag ids={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
