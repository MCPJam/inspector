import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "@/test";
import { OverrideBadge } from "../override-badge";

describe("OverrideBadge", () => {
  it("renders compact 'Inherited' chip (with the resolved value in the tooltip) and no reset when inheriting", () => {
    renderWithProviders(
      <OverrideBadge
        isInheriting
        suiteDefaultLabel="Strict order"
        onReset={() => {
          throw new Error("reset should not be wired in inherit state");
        }}
      />,
    );
    const chip = screen.getByTestId("override-badge-inheriting");
    expect(chip).toHaveTextContent(/^Inherited$/);
    expect(chip).toHaveAttribute(
      "title",
      "Inheriting suite default: Strict order",
    );
    expect(
      screen.queryByRole("button", { name: /reset to suite default/i }),
    ).not.toBeInTheDocument();
  });

  it("renders 'overriding · suite: X' chip with reset button when not inheriting", () => {
    const onReset = vi.fn();
    renderWithProviders(
      <OverrideBadge
        isInheriting={false}
        suiteDefaultLabel="Strict order"
        onReset={onReset}
      />,
    );
    expect(
      screen.getByTestId("override-badge-overriding"),
    ).toHaveTextContent(/overriding · suite: Strict order/);
    const resetBtn = screen.getByRole("button", {
      name: /reset to suite default/i,
    });
    fireEvent.click(resetBtn);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("renders override kind label ('replace') alongside suite reference", () => {
    renderWithProviders(
      <OverrideBadge
        isInheriting={false}
        suiteDefaultLabel="2 default checks"
        overrideKindLabel="replace"
        onReset={() => {}}
      />,
    );
    expect(
      screen.getByTestId("override-badge-overriding"),
    ).toHaveTextContent(/overriding · replace \(suite: 2 default checks\)/);
  });
});
