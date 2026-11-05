import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HOW_SUITES_WORK_SEEN_KEY,
  HOW_SUITES_WORK_STEPS,
  closeEventName,
  hasSeenHowSuitesWork,
  isLayerReached,
  stepOfLayer,
} from "../how-suites-work-model";
import { useHowSuitesWork } from "../use-how-suites-work";
import {
  HowSuitesWorkDialog,
  type HowSuitesWorkDialogProps,
} from "../how-suites-work-dialog";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("how suites work model", () => {
  it("has six steps that open and close on the whole flow", () => {
    expect(HOW_SUITES_WORK_STEPS).toHaveLength(6);
    expect(HOW_SUITES_WORK_STEPS[0].focus).toBeNull();
    expect(HOW_SUITES_WORK_STEPS[5].focus).toBeNull();
  });

  it.each([
    ["suite", 1],
    ["suiteRun", 2],
    ["testRun", 3],
    ["iteration", 4],
  ] as const)("maps the %s layer to step %i", (layer, step) => {
    expect(stepOfLayer(layer)).toBe(step);
  });

  it("reaches layers up to the lit one, and all of them on overview steps", () => {
    expect(isLayerReached(2, "suite")).toBe(true);
    expect(isLayerReached(2, "suiteRun")).toBe(true);
    expect(isLayerReached(2, "testRun")).toBe(false);
    expect(isLayerReached(0, "iteration")).toBe(true);
  });

  it("counts closing on the last step as completed", () => {
    expect(closeEventName(5)).toBe("eval_tutorial_completed");
    expect(closeEventName(4)).toBe("eval_tutorial_dismissed");
  });

  it("reads blocked storage as seen", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(hasSeenHowSuitesWork()).toBe(true);
  });
});

describe("useHowSuitesWork", () => {
  it("opens automatically once per browser, for whichever trigger comes first", () => {
    const { result } = renderHook(() => useHowSuitesWork());
    act(() => {
      expect(result.current.openAutomatically("first_visit")).toBe(true);
    });
    expect(result.current.open).toBe(true);
    expect(result.current.trigger).toBe("first_visit");
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBe("1");

    act(() => result.current.onOpenChange(false));
    act(() => {
      expect(result.current.openAutomatically("first_suite")).toBe(false);
    });
    expect(result.current.open).toBe(false);
  });

  it("opens on the first suite when the first visit did not open it", () => {
    const { result } = renderHook(() => useHowSuitesWork());
    act(() => {
      result.current.openAutomatically("first_suite");
    });
    expect(result.current.trigger).toBe("first_suite");
  });

  it("opens from the menu every time", () => {
    localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
    const { result } = renderHook(() => useHowSuitesWork());
    act(() => result.current.openFromMenu());
    expect(result.current.open).toBe(true);
    expect(result.current.trigger).toBe("menu");
  });
});

function renderDialog(overrides: Partial<HowSuitesWorkDialogProps> = {}) {
  const onEvent = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <HowSuitesWorkDialog
      open
      onOpenChange={onOpenChange}
      trigger="first_visit"
      onEvent={onEvent}
      {...overrides}
    />,
  );
  return { onEvent, onOpenChange };
}

describe("HowSuitesWorkDialog", () => {
  it("reports shown with the trigger and opens on the whole flow", () => {
    const { onEvent } = renderDialog();
    expect(onEvent).toHaveBeenCalledWith("eval_tutorial_shown", {
      trigger: "first_visit",
      step: 1,
    });
    expect(screen.getByText("The whole flow")).toBeInTheDocument();
    expect(screen.getByTestId("how-suites-work-mascot")).toBeInTheDocument();
  });

  it("walks every step to Got it and reports completed", async () => {
    const user = userEvent.setup();
    const { onEvent, onOpenChange } = renderDialog({ trigger: "menu" });
    await user.click(
      screen.getByRole("button", { name: "Walk me through it" }),
    );
    expect(
      screen.getByText("Your test cases, and where they run."),
    ).toBeInTheDocument();
    expect(screen.getByText("Suite page")).toBeInTheDocument();
    for (let i = 0; i < 4; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(screen.getByText("You're set")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(onEvent).toHaveBeenLastCalledWith("eval_tutorial_completed", {
      trigger: "menu",
      step: 6,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("reports dismissed with the step when skipped", async () => {
    const user = userEvent.setup();
    const { onEvent } = renderDialog();
    await user.click(
      screen.getByRole("button", { name: "Walk me through it" }),
    );
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onEvent).toHaveBeenLastCalledWith("eval_tutorial_dismissed", {
      trigger: "first_visit",
      step: 2,
    });
  });

  it("jumps to a layer from the spine and moves with the arrow keys", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole("button", { name: "Test run" }));
    expect(screen.getByRole("button", { name: "Test run" })).toHaveAttribute(
      "aria-current",
      "step",
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Iteration page")).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(screen.getByText("Suite run page")).toBeInTheDocument();
  });

  it("offers Build a test case on the last step when given a handler", async () => {
    const user = userEvent.setup();
    const onBuildCase = vi.fn();
    const { onEvent } = renderDialog({ onBuildCase });
    await user.click(
      screen.getByRole("button", { name: "Step 6: You're set" }),
    );
    await user.click(screen.getByRole("button", { name: "Build a test case" }));
    expect(onBuildCase).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenLastCalledWith(
      "eval_tutorial_completed",
      expect.objectContaining({ step: 6 }),
    );
  });
});
