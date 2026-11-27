import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { EvaluatorKindBadge } from "../evaluator-kind-badge";

describe("EvaluatorKindBadge", () => {
  it("labels an evaluator added from the library", () => {
    renderWithProviders(<EvaluatorKindBadge origin="library" />);
    expect(screen.getByText("Library")).toBeInTheDocument();
  });
});
