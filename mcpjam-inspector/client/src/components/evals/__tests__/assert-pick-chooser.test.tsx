import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import type { ElementLocator } from "@/shared/scripted-steps";
import {
  AssertPickChooser,
  buildStepAssertion,
  describeLocator,
  type AssertPick,
} from "../assert-pick-chooser";

const BUTTON_LOCATOR: ElementLocator = {
  role: { role: "button", name: "Add to cart" },
};
const PICK: AssertPick = {
  promptIndex: 0,
  toolName: "search-products",
  locator: BUTTON_LOCATOR,
};

describe("describeLocator", () => {
  it("prefers testId, then role+name, then text, then css", () => {
    expect(describeLocator({ testId: "cart" })).toBe('testId "cart"');
    expect(describeLocator(BUTTON_LOCATOR)).toBe('button "Add to cart"');
    expect(describeLocator({ role: { role: "list" } })).toBe("list");
    expect(describeLocator({ text: "Total" })).toBe('text "Total"');
    expect(describeLocator({ css: "div > span" })).toBe("element div > span");
  });
});

describe("buildStepAssertion", () => {
  it("builds value-less visible/hidden asserts with the locator", () => {
    expect(buildStepAssertion("elementVisible", BUTTON_LOCATOR, "")).toEqual({
      type: "elementVisible",
      target: BUTTON_LOCATOR,
    });
    expect(buildStepAssertion("elementHidden", BUTTON_LOCATOR, "")).toEqual({
      type: "elementHidden",
      target: BUTTON_LOCATOR,
    });
  });

  it("threads the typed value into text/input asserts", () => {
    expect(buildStepAssertion("textVisible", BUTTON_LOCATOR, "In cart")).toEqual(
      { type: "textVisible", text: "In cart" },
    );
    expect(buildStepAssertion("inputValue", BUTTON_LOCATOR, "2")).toEqual({
      type: "inputValue",
      target: BUTTON_LOCATOR,
      equals: "2",
    });
  });
});

describe("AssertPickChooser", () => {
  it("shows the picked element description", () => {
    renderWithProviders(
      <AssertPickChooser pick={PICK} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByText('button "Add to cart"')).toBeTruthy();
  });

  it("confirms a visible assert seeded with the locator (no value needed)", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <AssertPickChooser pick={PICK} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    // elementVisible is the default selection → confirm directly.
    await user.click(screen.getByTestId("assert-pick-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({
      type: "elementVisible",
      target: BUTTON_LOCATOR,
    });
  });

  it("requires a value for text asserts before confirming", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderWithProviders(
      <AssertPickChooser pick={PICK} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    await user.click(screen.getByTestId("assert-pick-textVisible"));
    // Confirm disabled until a value is typed.
    expect(screen.getByTestId("assert-pick-confirm")).toBeDisabled();

    await user.type(screen.getByLabelText(/text to look for/i), "In cart");
    await user.click(screen.getByTestId("assert-pick-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({
      type: "textVisible",
      text: "In cart",
    });
  });

  it("does not render when no element is picked", () => {
    renderWithProviders(
      <AssertPickChooser pick={null} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByTestId("assert-pick-confirm")).toBeNull();
  });
});
