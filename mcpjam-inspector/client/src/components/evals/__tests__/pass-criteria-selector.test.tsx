import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PassCriteriaSelector } from "../pass-criteria-selector";

/**
 * A number field with two masters.
 *
 * The prop moves for two different reasons — this field just reported a value,
 * or something else changed it (Discard, a colleague's save, a suite switch) —
 * and the input has to tell them apart. Following the prop always would erase
 * what someone is typing; following it never would leave the field showing a
 * number the draft no longer holds, which is the worst failure a settings
 * control has: it says the setting is one thing while the save writes another.
 */

function renderSelector(initial = 80) {
  const onChange = vi.fn();
  const view = render(
    <PassCriteriaSelector
      minimumPassRate={initial}
      onMinimumPassRateChange={onChange}
    />,
  );
  const input = screen.getByRole("spinbutton") as HTMLInputElement;
  const setProp = (rate: number) =>
    view.rerender(
      <PassCriteriaSelector
        minimumPassRate={rate}
        onMinimumPassRateChange={onChange}
      />,
    );
  return { input, onChange, setProp };
}

describe("an external change does not reach into a live edit", () => {
  it("keeps half-typed text when the prop moves underneath it", () => {
    const { input, setProp } = renderSelector(80);

    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    // Someone else saved, or the person hit Discard in another part of the
    // sheet. The field is mid-edit; the number in it belongs to the person.
    setProp(60);

    expect(input.value).toBe("9");
  });

  it("commits the typed value, not the one that arrived", () => {
    const { input, onChange, setProp } = renderSelector(80);

    input.focus();
    fireEvent.change(input, { target: { value: "95" } });
    setProp(60);
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(95);
  });

  it("still follows the prop when the field is focused but untouched", () => {
    const { input, onChange, setProp } = renderSelector(80);

    // Tabbing through a field is not editing it. Holding the old number here
    // is how a blur re-commits a value the person never chose.
    input.focus();
    setProp(60);
    expect(input.value).toBe("60");

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(60);
  });
});

describe("following the prop when nothing is being typed", () => {
  it("shows a discarded value rather than the edit it replaced", () => {
    const { input, setProp } = renderSelector(80);

    fireEvent.change(input, { target: { value: "95" } });
    fireEvent.blur(input);
    setProp(95); // the draft took the edit and echoed it back
    expect(input.value).toBe("95");

    // Discard rolls the draft back to what the server holds.
    setProp(80);
    expect(input.value).toBe("80");
  });

  it("follows a discard that lands after an abandoned edit", () => {
    const { input, setProp } = renderSelector(80);

    // A move the field ignored is still a move it has SEEN. Forgetting it
    // leaves the field convinced the value is 80 while the draft holds 60 —
    // so the discard back to 80 below reads as its own echo and never lands.
    input.focus();
    fireEvent.change(input, { target: { value: "9" } });
    setProp(60);
    expect(input.value).toBe("9");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("60");

    setProp(80);
    expect(input.value).toBe("80");
  });

  it("does not re-report the value it just received", () => {
    const { input, onChange, setProp } = renderSelector(80);

    setProp(60);
    fireEvent.blur(input);

    // Blurring a field nobody edited must not file a fresh edit.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(60);
  });
});

describe("committing and abandoning", () => {
  it("clamps out of range values on blur", () => {
    const { input, onChange } = renderSelector(80);

    fireEvent.change(input, { target: { value: "140" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith(100);
    expect(input.value).toBe("100");
  });

  it("Escape abandons the edit instead of committing it", () => {
    const { input, onChange } = renderSelector(80);

    input.focus();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Escape" });

    // Escape gets out of the field by blurring it, and blurring is what
    // commits — so without a guard, the cancel wrote the very value it was
    // cancelling.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("80");
  });

  it("a later blur still commits after an abandoned edit", () => {
    const { input, onChange } = renderSelector(80);

    input.focus();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.keyDown(input, { key: "Escape" });

    input.focus();
    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(70);
  });

  it("Enter commits", () => {
    const { input, onChange } = renderSelector(80);

    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith(70);
  });
});
