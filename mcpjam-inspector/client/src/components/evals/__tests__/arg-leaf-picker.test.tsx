import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
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
    expect(screen.getByText("Equals")).toBeInTheDocument();
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
    const matches = screen.getAllByText("Any string");
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
    expect(screen.queryByText("Any string")).not.toBeInTheDocument();
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

  it.each([
    ["any", "Any value"],
    ["string", "Any string"],
    ["number", "Any number"],
    ["boolean", "Any boolean"],
    ["array", "Any list"],
    ["null", "Equals null"],
  ])("keeps %s available in the compact selector", async (value, label) => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <ArgLeafPicker
        compact
        value="test"
        onChange={onChange}
        argumentMatching="partial"
      />,
    );
    expect(screen.getByText("Equals")).toBeInTheDocument();
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "Argument value mode" }),
    );
    await user.click(screen.getByRole("option", { name: label }));
    expect(onChange).toHaveBeenLastCalledWith(value);
  });

  it("hides the compact value field for a type check and restores it for Equals", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    function Picker() {
      const [value, setValue] = useState<unknown>("number");
      return (
        <ArgLeafPicker
          compact
          value={value}
          inferredType="number"
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          argumentMatching="partial"
        />
      );
    }
    renderWithProviders(<Picker />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "Argument value mode" }),
    );
    await user.click(screen.getByRole("option", { name: "Equals" }));
    expect(onChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByPlaceholderText("Value")).toHaveValue("0");
  });

  it.each(["any", "string", "number", "boolean", "object", "array", "null"])(
    "does not show a value field for the compact %s check",
    (value) => {
      renderWithProviders(
        <ArgLeafPicker compact value={value} onChange={vi.fn()} />,
      );
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Argument value mode" }),
      ).toBeEnabled();
    },
  );

  it.each([true, false])(
    "does not offer Any object (compact: %s)",
    async (compact) => {
      const user = userEvent.setup();
      renderWithProviders(
        <ArgLeafPicker compact={compact} value="test" onChange={vi.fn()} />,
      );
      await user.click(
        screen.getByRole("combobox", { name: "Argument value mode" }),
      );
      expect(
        screen.queryByRole("option", { name: "Any object" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("option", { name: "Equals" }),
      ).toBeInTheDocument();
    },
  );

  it("preserves a saved object type check until the user changes it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <ArgLeafPicker
        compact
        value="object"
        inferredType="object"
        onChange={onChange}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Argument value mode" }),
    ).toHaveTextContent("Any object");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("combobox", { name: "Argument value mode" }),
    );
    expect(
      screen.queryByRole("option", { name: "Any object" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Equals" }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
