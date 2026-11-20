import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent, MouseEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStepRangeSelect } from "../use-step-range-select";

type Step = "a" | "b" | "c" | "d";

interface HookProps {
  orderedSteps: Step[];
  available: boolean;
  copySteps: (steps: Step[]) => Promise<boolean>;
}

function setup(overrides: Partial<HookProps> = {}) {
  const copySteps = vi.fn(async (_steps: Step[]) => true);
  const initialProps: HookProps = {
    orderedSteps: ["a", "b", "c", "d"],
    available: true,
    copySteps,
    ...overrides,
  };
  const hook = renderHook((props: HookProps) => useStepRangeSelect(props), {
    initialProps,
  });
  return { ...hook, copySteps: initialProps.copySteps, initialProps };
}

function click(
  result: { current: ReturnType<typeof useStepRangeSelect<Step>> },
  step: Step,
  shiftKey = false,
) {
  const props = result.current.getStepHeaderProps(step, step);
  act(() => {
    (props as { onClick: (event: MouseEvent) => void }).onClick({
      shiftKey,
    } as MouseEvent);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useStepRangeSelect", () => {
  it("leaves step headers untouched outside select mode", () => {
    const { result } = setup();

    expect(result.current.isSelecting).toBe(false);
    expect(result.current.getStepHeaderProps("a", "1. A")).toEqual({});
    expect(result.current.isSelected("a")).toBe(false);
  });

  it("turns step headers into labelled checkboxes in select mode", () => {
    const { result } = setup();
    act(() => result.current.enter());

    const props = result.current.getStepHeaderProps("a", "1. A");
    expect(props).toMatchObject({
      role: "checkbox",
      "aria-checked": false,
      "aria-label": "Select step 1. A",
    });
    expect(props).toHaveProperty("aria-expanded", undefined);

    click(result, "a");
    expect(result.current.getStepHeaderProps("a", "1. A")).toMatchObject({
      "aria-checked": true,
    });
  });

  it("toggles single steps on and off", () => {
    const { result } = setup();
    act(() => result.current.enter());

    click(result, "b");
    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.selectedCount).toBe(1);

    click(result, "b");
    expect(result.current.isSelected("b")).toBe(false);
    expect(result.current.selectedCount).toBe(0);
  });

  it("toggles with Enter and Space, and ignores other keys", () => {
    const { result } = setup();
    act(() => result.current.enter());

    const press = (key: string) => {
      const preventDefault = vi.fn();
      const props = result.current.getStepHeaderProps("c", "3. C") as {
        onKeyDown: (event: KeyboardEvent) => void;
      };
      act(() => {
        props.onKeyDown({
          key,
          shiftKey: false,
          preventDefault,
        } as unknown as KeyboardEvent);
      });
      return preventDefault;
    };

    expect(press("Enter")).toHaveBeenCalled();
    expect(result.current.isSelected("c")).toBe(true);
    expect(press(" ")).toHaveBeenCalled();
    expect(result.current.isSelected("c")).toBe(false);
    expect(press("Tab")).not.toHaveBeenCalled();
    expect(result.current.isSelected("c")).toBe(false);
  });

  it("shift-click selects the whole range, including when clicked backwards", () => {
    const { result } = setup();
    act(() => result.current.enter());

    click(result, "d");
    click(result, "b", true);

    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.isSelected("c")).toBe(true);
    expect(result.current.isSelected("d")).toBe(true);
    expect(result.current.isSelected("a")).toBe(false);
    expect(result.current.selectedCount).toBe(3);
  });

  it("treats a shift-click with no earlier click as a plain toggle", () => {
    const { result } = setup();
    act(() => result.current.enter());

    click(result, "c", true);

    expect(result.current.selectedCount).toBe(1);
    expect(result.current.isSelected("c")).toBe(true);
  });

  it("keeps the range anchored to a step when steps are added mid-selection", () => {
    const { result, rerender, initialProps } = setup({
      orderedSteps: ["b", "c", "d"],
    });
    act(() => result.current.enter());
    click(result, "c");

    // A step that sorts earlier arrives and shifts every index by one.
    rerender({ ...initialProps, orderedSteps: ["a", "b", "c", "d"] });
    click(result, "d", true);

    expect(result.current.isSelected("b")).toBe(false);
    expect(result.current.isSelected("c")).toBe(true);
    expect(result.current.isSelected("d")).toBe(true);
    expect(result.current.selectedCount).toBe(2);
  });

  it("copies the selection in flow order, whatever order it was picked in", async () => {
    const { result, copySteps } = setup();
    act(() => result.current.enter());
    click(result, "d");
    click(result, "a");

    await act(() => result.current.copySelected());

    expect(copySteps).toHaveBeenCalledWith(["a", "d"]);
    expect(result.current.copyState).toBe("success");
  });

  it("does not copy an empty selection", async () => {
    const { result, copySteps } = setup();
    act(() => result.current.enter());

    await act(() => result.current.copySelected());

    expect(copySteps).not.toHaveBeenCalled();
    expect(result.current.copyState).toBe("idle");
  });

  it("reports a failed copy and returns to idle after a moment", async () => {
    vi.useFakeTimers();
    const { result } = setup({ copySteps: vi.fn(async () => false) });
    act(() => result.current.enter());
    click(result, "a");

    await act(() => result.current.copySelected());
    expect(result.current.copyState).toBe("error");

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.copyState).toBe("idle");
  });

  it("clears the copy result and selection on Cancel and on re-entering", async () => {
    const { result } = setup();
    act(() => result.current.enter());
    click(result, "a");
    await act(() => result.current.copySelected());
    expect(result.current.copyState).toBe("success");

    act(() => result.current.exit());
    expect(result.current.isSelecting).toBe(false);
    expect(result.current.copyState).toBe("idle");
    expect(result.current.selectedCount).toBe(0);

    act(() => result.current.enter());
    expect(result.current.copyState).toBe("idle");
    expect(result.current.isSelected("a")).toBe(false);
  });

  it("drops steps that leave the list from the count and the copy", async () => {
    const { result, rerender, initialProps, copySteps } = setup();
    act(() => result.current.enter());
    click(result, "a");
    click(result, "d");

    rerender({ ...initialProps, orderedSteps: ["a", "b", "c"] });
    expect(result.current.selectedCount).toBe(1);

    await act(() => result.current.copySelected());
    expect(copySteps).toHaveBeenCalledWith(["a"]);
  });

  it("leaves select mode when selection stops being available", () => {
    const { result, rerender, initialProps } = setup();
    act(() => result.current.enter());
    click(result, "a");

    rerender({ ...initialProps, available: false });

    expect(result.current.isSelecting).toBe(false);
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.available).toBe(false);
  });
});
