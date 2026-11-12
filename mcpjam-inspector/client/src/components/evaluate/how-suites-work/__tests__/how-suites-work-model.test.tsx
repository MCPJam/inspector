import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOW_SUITES_WORK_STEPS, stepOfLayer } from "../how-suites-work-steps";
import {
  HOW_SUITES_WORK_SEEN_KEY,
  hasSeenHowSuitesWork,
  markHowSuitesWorkSeen,
} from "../how-suites-work-seen";
import { useHowSuitesWork } from "../use-how-suites-work";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("steps model", () => {
  it("holds the six steps with their exact copy", () => {
    expect(
      HOW_SUITES_WORK_STEPS.map(({ focus, show, title, say, page, trail }) => [
        focus,
        show,
        title,
        say,
        page,
        trail,
      ]),
    ).toEqual([
      [
        null,
        4,
        "The whole flow",
        "Evals nest four layers deep. Here they are.",
        undefined,
        undefined,
      ],
      [
        "suite",
        1,
        "Suite",
        "Your test cases, and where they run.",
        "Suite page",
        ["Evaluate", "Excalidraw quickstart"],
      ],
      [
        "run",
        2,
        "Suite run",
        "Press Run. Each press makes a new run.",
        "Suite Run page",
        ["Excalidraw quickstart", "Run #6"],
      ],
      [
        "testRun",
        3,
        "Test run",
        "One test case inside a run. It passes, fails, or is flaky.",
        "Test run page",
        ["Run #6", "Draw a rectangle"],
      ],
      [
        "iteration",
        4,
        "Iteration",
        "One try of a test run. Each try has its own chat and scorecard.",
        "Iteration page",
        ["Draw a rectangle", "Iteration #2"],
      ],
      [
        null,
        4,
        "You're set",
        "Build a test case, then press Run.",
        undefined,
        undefined,
      ],
    ]);
  });

  it("maps each layer to its 0-based step", () => {
    expect(stepOfLayer("suite")).toBe(1);
    expect(stepOfLayer("run")).toBe(2);
    expect(stepOfLayer("testRun")).toBe(3);
    expect(stepOfLayer("iteration")).toBe(4);
  });
});

describe("seen storage", () => {
  it("is unseen until marked, then stores 1", () => {
    expect(hasSeenHowSuitesWork()).toBe(false);
    markHowSuitesWorkSeen();
    expect(hasSeenHowSuitesWork()).toBe(true);
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBe("1");
  });

  it("counts a failed read as seen", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(hasSeenHowSuitesWork()).toBe(true);
  });

  it("ignores a failed write", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markHowSuitesWorkSeen()).not.toThrow();
  });
});

describe("useHowSuitesWork", () => {
  it("opens once on first visit and writes the key", () => {
    const { result } = renderHook(() => useHowSuitesWork({ autoOpen: true }));
    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.trigger).toBe("first_visit");
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBe("1");
  });

  it("stays closed when already seen", () => {
    markHowSuitesWorkSeen();
    const { result } = renderHook(() => useHowSuitesWork({ autoOpen: true }));
    expect(result.current.dialogProps.open).toBe(false);
  });

  it("stays closed and leaves the key alone without autoOpen", () => {
    const { result } = renderHook(() => useHowSuitesWork({ autoOpen: false }));
    expect(result.current.dialogProps.open).toBe(false);
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBeNull();
  });

  it("opens when autoOpen turns on", () => {
    const { result, rerender } = renderHook(
      ({ autoOpen }) => useHowSuitesWork({ autoOpen }),
      { initialProps: { autoOpen: false } },
    );
    expect(result.current.dialogProps.open).toBe(false);
    rerender({ autoOpen: true });
    expect(result.current.dialogProps.open).toBe(true);
  });

  it("opens once under StrictMode", () => {
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const { result } = renderHook(() => useHowSuitesWork({ autoOpen: true }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>{children}</StrictMode>
      ),
    });
    expect(result.current.dialogProps.open).toBe(true);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it("opens from the menu without touching the key, again after closing", () => {
    const { result } = renderHook(() => useHowSuitesWork({ autoOpen: false }));
    act(() => result.current.openFromMenu());
    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.trigger).toBe("menu");
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBeNull();

    act(() => result.current.dialogProps.onOpenChange(false));
    expect(result.current.dialogProps.open).toBe(false);
    act(() => result.current.openFromMenu());
    expect(result.current.dialogProps.open).toBe(true);
  });
});
