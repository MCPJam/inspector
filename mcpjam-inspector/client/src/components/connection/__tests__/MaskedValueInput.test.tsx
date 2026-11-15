import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MaskedValueInput } from "../shared/MaskedValueInput";

describe("MaskedValueInput", () => {
  it("stays editable while visible by default", () => {
    const onChange = vi.fn();
    render(
      <MaskedValueInput
        value="abc"
        onChange={onChange}
        visible
        onToggleVisibility={vi.fn()}
        inputLabel="Value"
        subject="value"
      />,
    );
    const input = screen.getByLabelText("Value");
    expect(input).not.toHaveAttribute("readonly");
    fireEvent.change(input, { target: { value: "abcd" } });
    expect(onChange).toHaveBeenCalledWith("abcd");
  });

  it("can't be typed into when read-only, even while visible", () => {
    const onChange = vi.fn();
    render(
      <MaskedValueInput
        value="abc"
        onChange={onChange}
        visible
        readOnly
        onToggleVisibility={vi.fn()}
        inputLabel="Value"
        subject="value"
      />,
    );
    const input = screen.getByLabelText("Value");
    expect(input).toHaveValue("abc");
    expect(input).toHaveAttribute("readonly");
    fireEvent.change(input, { target: { value: "abcd" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
