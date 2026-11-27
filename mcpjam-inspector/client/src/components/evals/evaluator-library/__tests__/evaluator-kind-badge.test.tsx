import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { EvaluatorKindBadge } from "../evaluator-kind-badge";

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
