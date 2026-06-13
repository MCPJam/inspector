import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { XAARunChips } from "../XAARunChips";

describe("XAARunChips", () => {
  it("renders every step untouched at idle", () => {
    render(<XAARunChips flowState={{ currentStep: "idle" }} />);

    const chips = screen.getAllByTestId(/xaa-run-chip-/);
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("data-status", "untouched");
    }
  });

  it("shows a partial run as green/red/untouched", () => {
    render(
      <XAARunChips
        flowState={{ currentStep: "jwt_bearer_request", error: "boom" }}
      />,
    );

    // Steps before the failure are green.
    expect(
      screen.getByTestId("xaa-run-chip-token_exchange_request"),
    ).toHaveAttribute("data-status", "pass");
    // The failing step is red.
    expect(
      screen.getByTestId("xaa-run-chip-jwt_bearer_request"),
    ).toHaveAttribute("data-status", "fail");
    // Steps after it stay untouched.
    expect(
      screen.getByTestId("xaa-run-chip-authenticated_mcp_request"),
    ).toHaveAttribute("data-status", "untouched");
  });

  it("shows everything green on completion", () => {
    render(<XAARunChips flowState={{ currentStep: "complete" }} />);

    const chips = screen.getAllByTestId(/xaa-run-chip-/);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("data-status", "pass");
    }
  });
});
