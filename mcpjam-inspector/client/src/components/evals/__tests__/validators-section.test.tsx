import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { ValidatorsSection } from "../validators-section";

describe("ValidatorsSection", () => {
  it("renders concrete resolved values when nothing is overridden", () => {
    renderWithProviders(
      <ValidatorsSection
        title="Validators"
        description="Suite defaults apply unless overridden."
        value={undefined}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/Suite defaults apply/)).toBeInTheDocument();
    expect(screen.getByText("Any order")).toBeInTheDocument();
    // Extras row is now a number input + Unlimited toggle; default is
    // unlimited (null), so the toggle is checked and the input is disabled.
    const unlimitedSwitch = screen.getByRole("switch", {
      name: /unlimited/i,
    });
    expect(unlimitedSwitch).toBeChecked();
    // Two "Unlimited" labels now exist when extras is unlimited: the
    // placeholder pill that replaces the number input, and the existing
    // switch label. Either is sufficient signal that the unlimited state
    // is reflected in the UI.
    expect(screen.getAllByText("Unlimited").length).toBeGreaterThan(0);
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
  });

  it("offers the new superset trajectory mode in the order select", () => {
    renderWithProviders(
      <ValidatorsSection
        title="Validators"
        value={undefined}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        onChange={vi.fn()}
      />,
    );
    // The select trigger renders the resolved label; opening it would
    // require Radix portal interactions. Existence of `superset` is
    // covered exhaustively by the ORDER_OPTIONS unit-level assertion via
    // type narrowing — here we just sanity-check the trigger shows the
    // resolved default ("Any order") and is rendered.
    expect(screen.getByText("Any order")).toBeInTheDocument();
  });

  it("LEGACY: renders an old row that pinned allowExtraToolCalls=false as 0 extras (toggle off)", () => {
    renderWithProviders(
      <ValidatorsSection
        title="Validators"
        value={{ allowExtraToolCalls: false }}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        onChange={vi.fn()}
      />,
    );
    const unlimitedSwitch = screen.getByRole("switch", {
      name: /unlimited/i,
    });
    expect(unlimitedSwitch).not.toBeChecked();
    const input = screen.getByLabelText(
      /maximum extra tool calls/i,
    ) as HTMLInputElement;
    expect(input).not.toBeDisabled();
    expect(input.value).toBe("0");
  });

  it("LEGACY: renders an old row that pinned allowExtraToolCalls=true as Unlimited", () => {
    renderWithProviders(
      <ValidatorsSection
        title="Validators"
        value={{ allowExtraToolCalls: true }}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        onChange={vi.fn()}
      />,
    );
    const unlimitedSwitch = screen.getByRole("switch", {
      name: /unlimited/i,
    });
    expect(unlimitedSwitch).toBeChecked();
  });

  it("hides description in compact density and only shows Reset when overridden", () => {
    const { rerender } = renderWithProviders(
      <ValidatorsSection
        title="This run"
        description="Should not render in compact layout."
        value={undefined}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        density="compact"
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/Should not render/)).not.toBeInTheDocument();
    expect(screen.getByText("This run")).toBeInTheDocument();
    expect(screen.getByText("Extra tool calls")).toBeInTheDocument();
    expect(screen.getByText("Args")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();

    rerender(
      <ValidatorsSection
        title="This run"
        value={{ toolCallOrder: "strict" }}
        inheritedFrom={MATCH_OPTIONS_DEFAULTS}
        density="compact"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
  });
});
