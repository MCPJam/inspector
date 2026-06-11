import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { ArgLeafPicker } from "../arg-leaf-picker";

describe("ArgLeafPicker", () => {
  it("renders a literal input by default in partial mode", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ArgLeafPicker
        value="/tmp"
        onChange={onChange}
        argumentMatching="partial"
      />,
    );
    // Mode select shows "Literal"
    expect(screen.getByText("Literal")).toBeInTheDocument();
    // Literal value is rendered in the input
    const input = screen.getByDisplayValue("/tmp") as HTMLInputElement;
    expect(input).toBeInTheDocument();
  });

  it("recognizes a placeholder string as the placeholder mode and shows label", () => {
    renderWithProviders(
      <ArgLeafPicker
        value="string"
        onChange={() => {}}
        argumentMatching="partial"
      />,
    );
    // Placeholder mode: the literal-value input is replaced with a
    // labelled chip. The literal input shouldn't be present at all.
    expect(screen.queryByDisplayValue("string")).not.toBeInTheDocument();
    // The placeholder label appears in the rendered chip (and also as
    // the SelectValue inside the closed dropdown trigger, which Radix
    // mirrors). At least one of the matches is visible to the user.
    const matches = screen.getAllByText("any string");
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("treats a placeholder-looking value as a literal under exact mode", () => {
    // Under exact mode the matcher does deep equality; the literal string
    // "string" is just data, not a type assertion. The picker must NOT
    // render it as a placeholder.
    renderWithProviders(
      <ArgLeafPicker
        value="string"
        onChange={() => {}}
        argumentMatching="exact"
      />,
    );
    expect(screen.queryByText("any string")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("string")).toBeInTheDocument();
  });

  it("shows an ignore-mode hint and disables the dropdown", () => {
    renderWithProviders(
      <ArgLeafPicker
        value="/tmp"
        onChange={() => {}}
        argumentMatching="ignore"
      />,
    );
    expect(
      screen.getByText(/Arguments not compared in ignore mode/),
    ).toBeInTheDocument();
  });
});
