/** The tutorial's seen key, auto-open rules and the hook 2A mounts. */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOW_SUITES_WORK_SEEN_KEY,
  autoOpenTrigger,
  hasSeenHowSuitesWork,
  markHowSuitesWorkSeen,
  useHowSuitesWork,
} from "../how-suites-work";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("autoOpenTrigger", () => {
  it.each([
    ["evaluate_visit", true, false, "first_visit"],
    ["suite_created", true, false, "first_suite"],
    ["evaluate_visit", true, true, null],
    ["suite_created", true, true, null],
    ["evaluate_visit", false, false, null],
    ["suite_created", false, false, null],
  ] as const)(
    "%s enabled=%s seen=%s → %s",
    (event, enabled, seen, expected) => {
      expect(autoOpenTrigger(event, { enabled, seen })).toBe(expected);
    },
  );
});

describe("seen key", () => {
  it("round-trips with the value 1", () => {
    expect(hasSeenHowSuitesWork()).toBe(false);
    markHowSuitesWorkSeen();
    expect(localStorage.getItem(HOW_SUITES_WORK_SEEN_KEY)).toBe("1");
    expect(hasSeenHowSuitesWork()).toBe(true);
  });

  it("reads as unseen when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(hasSeenHowSuitesWork()).toBe(false);
  });

  it("does not throw when writing fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markHowSuitesWorkSeen()).not.toThrow();
  });
});

describe("useHowSuitesWork", () => {
  it("opens once on the first notify and marks it seen", () => {
    const { result } = renderHook(() => useHowSuitesWork({ enabled: true }));
    act(() => result.current.notifyEvaluateVisit());
    expect(result.current.open).toBe(true);
    expect(result.current.trigger).toBe("first_visit");
    expect(hasSeenHowSuitesWork()).toBe(true);

    act(() => result.current.setOpen(false));
    act(() => result.current.notifySuiteCreated());
    act(() => result.current.notifyEvaluateVisit());
    expect(result.current.open).toBe(false);
  });

  it("opens on the first suite when that comes first", () => {
    const { result } = renderHook(() => useHowSuitesWork({ enabled: true }));
    act(() => result.current.notifySuiteCreated());
    expect(result.current.open).toBe(true);
    expect(result.current.trigger).toBe("first_suite");
  });

  it("always opens from the menu, even when seen", () => {
    markHowSuitesWorkSeen();
    const { result } = renderHook(() => useHowSuitesWork({ enabled: true }));
    act(() => result.current.openFromMenu());
    expect(result.current.open).toBe(true);
    expect(result.current.trigger).toBe("menu");
  });

  it("never auto-opens while disabled, then opens once enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }) => useHowSuitesWork({ enabled }),
      { initialProps: { enabled: false } },
    );
    act(() => result.current.notifyEvaluateVisit());
    act(() => result.current.notifySuiteCreated());
    expect(result.current.open).toBe(false);
    expect(hasSeenHowSuitesWork()).toBe(false);

    rerender({ enabled: true });
    act(() => result.current.notifyEvaluateVisit());
    expect(result.current.open).toBe(true);
  });
});
