import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
      />
    );

    // Steps before the failure are green.
    expect(
      screen.getByTestId("xaa-run-chip-token_exchange_request")
    ).toHaveAttribute("data-status", "pass");
    // The failing step is red.
    expect(
      screen.getByTestId("xaa-run-chip-jwt_bearer_request")
    ).toHaveAttribute("data-status", "fail");
    // Steps after it stay untouched.
    expect(
      screen.getByTestId("xaa-run-chip-authenticated_mcp_request")
    ).toHaveAttribute("data-status", "untouched");
  });

  it("shows everything green on completion", () => {
    render(<XAARunChips flowState={{ currentStep: "complete" }} />);

    const chips = screen.getAllByTestId(/xaa-run-chip-/);
    for (const chip of chips) {
      expect(chip).toHaveAttribute("data-status", "pass");
    }
  });

  it("focuses a step when its segment is clicked after a full run", async () => {
    const onFocusStep = vi.fn();
    const user = userEvent.setup();
    render(
      <XAARunChips
        flowState={{ currentStep: "complete" }}
        onFocusStep={onFocusStep}
      />
    );

    await user.click(screen.getByTestId("xaa-run-chip-token_exchange_request"));

    expect(onFocusStep).toHaveBeenCalledWith("token_exchange_request");
  });

  it("renders inert segments when no focus handler is provided", () => {
    render(<XAARunChips flowState={{ currentStep: "complete" }} />);

    for (const chip of screen.getAllByTestId(/xaa-run-chip-/)) {
      expect(chip).toBeDisabled();
    }
  });

  it("does not focus a step that has not run yet", async () => {
    const onFocusStep = vi.fn();
    const user = userEvent.setup();
    render(
      <XAARunChips
        flowState={{ currentStep: "idle" }}
        onFocusStep={onFocusStep}
      />
    );

    const chip = screen.getByTestId("xaa-run-chip-token_exchange_request");
    expect(chip).toHaveAttribute("aria-disabled", "true");
    await user.click(chip);

    expect(onFocusStep).not.toHaveBeenCalled();
  });

  it("shows the section name when a segment is hovered", async () => {
    const user = userEvent.setup();
    render(
      <XAARunChips
        flowState={{ currentStep: "complete" }}
        onFocusStep={vi.fn()}
      />
    );

    await user.hover(screen.getByTestId("xaa-run-chip-token_exchange_request"));

    expect(screen.getByText("RFC 8693 Token Exchange")).toBeInTheDocument();
  });
});
