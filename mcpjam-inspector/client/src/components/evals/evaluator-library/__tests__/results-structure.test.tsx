import { Syringe } from "lucide-react";
import { describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { CheckRow } from "../check-row";
import { ScorecardEvaluatorCard } from "../scorecard-evaluator-card";
import { VerdictPill } from "../verdict-pill";

describe("VerdictPill", () => {
  it("says each status in words and lets a score replace the word", () => {
    const { rerender } = renderWithProviders(<VerdictPill status="error" />);
    expect(screen.getByText("Error")).toHaveAttribute("data-status", "error");
    rerender(<VerdictPill status="not_applicable" />);
    expect(screen.getByText("Not applicable")).toBeInTheDocument();
    rerender(<VerdictPill status="passed" label="0.91" size="sm" />);
    expect(screen.getByText("0.91")).toHaveAttribute("data-status", "passed");
  });

  it("still names the verdict to a screen reader when a score replaces it", () => {
    const { rerender } = renderWithProviders(
      <VerdictPill status="failed" label="0.62" />,
    );
    expect(screen.getByText("Failed:")).toHaveClass("sr-only");
    rerender(<VerdictPill status="passed" label="0.62" />);
    expect(screen.getByText("Passed:")).toHaveClass("sr-only");
  });
});

describe("CheckRow", () => {
  it("shows the result with what was observed", () => {
    renderWithProviders(
      <ul>
        <CheckRow
          label="Called the expected tools"
          role="required"
          status="failed"
          evidence="Called search_catalog first"
        />
      </ul>,
    );
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Called search_catalog first");
    expect(row).toHaveTextContent("Failed");
  });
});

describe("CheckRow evidence", () => {
  it("shows an observed count of zero", () => {
    renderWithProviders(
      <ul>
        <CheckRow
          label="Tool calls"
          role="required"
          status="passed"
          evidence={0}
        />
      </ul>,
    );
    expect(screen.getByText("0")).toBeInTheDocument();
  });
});

describe("ScorecardEvaluatorCard", () => {
  const props = {
    name: "Ignores Injected Instructions",
    icon: Syringe,
    origin: "library" as const,
    checks: [
      {
        id: "a",
        label: "Did not call send_email",
        role: "required" as const,
        status: "passed" as const,
      },
      {
        id: "b",
        label: "Did not follow the planted instruction",
        role: "required" as const,
        status: "failed" as const,
      },
    ],
  };

  it("opens a failed evaluator with the failing check first", () => {
    renderWithProviders(<ScorecardEvaluatorCard {...props} status="failed" />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Did not follow the planted instruction");
    expect(rows[1]).toHaveTextContent("Did not call send_email");
  });

  it("starts a passed evaluator collapsed", () => {
    renderWithProviders(<ScorecardEvaluatorCard {...props} status="passed" />);
    expect(
      screen.getByRole("button", { name: /Ignores Injected Instructions/ }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
