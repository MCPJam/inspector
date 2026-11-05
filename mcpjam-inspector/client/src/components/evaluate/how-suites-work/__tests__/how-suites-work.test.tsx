import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "@/lib/analytics";
import { HowSuitesWorkDialog } from "../how-suites-work-dialog";
import {
  HOW_SUITES_WORK_SEEN_KEY,
  HOW_SUITES_WORK_STEPS,
  markHowSuitesWorkSeen,
  readHowSuitesWorkSeen,
  shouldShowHowSuitesWork,
} from "../how-suites-work-model";
import { useHowSuitesWork } from "../use-how-suites-work";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const trackMock = vi.mocked(track);

beforeEach(() => {
  window.localStorage.clear();
  trackMock.mockClear();
  vi.restoreAllMocks();
});

describe("shouldShowHowSuitesWork", () => {
  it.each([
    ["first_visit", false, true],
    ["first_visit", true, false],
    ["first_suite", false, true],
    ["first_suite", true, false],
    ["menu", false, true],
    ["menu", true, true],
  ] as const)("%s with seen=%s → %s", (trigger, seen, expected) => {
    expect(shouldShowHowSuitesWork(trigger, seen)).toBe(expected);
  });
});

describe("seen flag", () => {
  it("persists under its key", () => {
    expect(readHowSuitesWorkSeen()).toBe(false);
    markHowSuitesWorkSeen();
    expect(window.localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBe("1");
    expect(readHowSuitesWorkSeen()).toBe(true);
  });

  it("reads as unseen and does not throw when storage fails", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readHowSuitesWorkSeen()).toBe(false);
    expect(() => markHowSuitesWorkSeen()).not.toThrow();
  });
});

describe("useHowSuitesWork", () => {
  it("auto-opens once, then only from the menu", () => {
    const { result } = renderHook(() => useHowSuitesWork());
    act(() => expect(result.current.request("first_visit")).toBe(true));
    expect(result.current.trigger).toBe("first_visit");
    expect(readHowSuitesWorkSeen()).toBe(true);

    act(() => result.current.close());
    act(() => expect(result.current.request("first_suite")).toBe(false));
    expect(result.current.trigger).toBeNull();

    act(() => expect(result.current.request("menu")).toBe(true));
    expect(result.current.trigger).toBe("menu");
  });

  it("ignores a second request while open", () => {
    const { result } = renderHook(() => useHowSuitesWork());
    act(() => void result.current.request("first_visit"));
    act(() => expect(result.current.request("menu")).toBe(false));
    expect(result.current.trigger).toBe("first_visit");
  });
});

describe("HowSuitesWorkDialog", () => {
  const heading = () => screen.getByRole("heading").textContent;

  it("renders nothing while closed", () => {
    render(<HowSuitesWorkDialog trigger={null} onClose={vi.fn()} />);
    expect(screen.queryByTestId("how-suites-work")).toBeNull();
    expect(trackMock).not.toHaveBeenCalled();
  });

  it("walks every step and reports completion", () => {
    const onClose = vi.fn();
    render(<HowSuitesWorkDialog trigger="first_visit" onClose={onClose} />);
    expect(trackMock).toHaveBeenCalledWith("eval_tutorial_shown", {
      trigger: "first_visit",
      step: 1,
    });
    expect(heading()).toBe(HOW_SUITES_WORK_STEPS[0].title);
    expect(screen.getByTestId("how-suites-work-possum")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Walk me through it" }));
    for (let i = 1; i < HOW_SUITES_WORK_STEPS.length - 1; i++) {
      expect(heading()).toBe(HOW_SUITES_WORK_STEPS[i].title);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
    }
    expect(heading()).toBe("You're set");
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(trackMock).toHaveBeenLastCalledWith("eval_tutorial_completed", {
      trigger: "first_visit",
      step: HOW_SUITES_WORK_STEPS.length,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back, jumps by layer and moves with arrow keys", () => {
    render(<HowSuitesWorkDialog trigger="menu" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test run" }));
    expect(heading()).toBe("Test run");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(heading()).toBe("Suite run");
    fireEvent.keyDown(screen.getByTestId("how-suites-work"), {
      key: "ArrowRight",
    });
    expect(heading()).toBe("Test run");
    fireEvent.keyDown(screen.getByTestId("how-suites-work"), {
      key: "ArrowLeft",
    });
    expect(heading()).toBe("Suite run");
  });

  it("reports the step where it was skipped", () => {
    const onClose = vi.fn();
    render(<HowSuitesWorkDialog trigger="first_suite" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Walk me through it" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(trackMock).toHaveBeenLastCalledWith("eval_tutorial_dismissed", {
      trigger: "first_suite",
      step: 2,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
