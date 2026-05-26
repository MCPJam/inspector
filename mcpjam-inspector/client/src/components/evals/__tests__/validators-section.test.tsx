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
    expect(screen.getByText("Allow extras")).toBeInTheDocument();
    expect(screen.getByText("Partial")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
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
