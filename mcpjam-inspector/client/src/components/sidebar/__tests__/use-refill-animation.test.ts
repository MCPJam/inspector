import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REFILL_HOLD_MS,
  useRefillAnimation,
} from "@/components/sidebar/use-refill-animation";

const KEY = "mcpjam:credits-last-seen:org_a:sidebar-usage-daily";

describe("useRefillAnimation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("starts empty once after a refill, then fills", () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, "12");
    const { result } = renderHook(() => useRefillAnimation(KEY, 300));

    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(REFILL_HOLD_MS - 1));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("300");
  });

  it("still animates when the card opens before the meter loads", () => {
    vi.useFakeTimers();
    localStorage.setItem(KEY, "12");
    const { result, rerender } = renderHook(
      ({ key, remaining }) => useRefillAnimation(key, remaining),
      {
        initialProps: {
          key: null as string | null,
          remaining: null as number | null,
        },
      },
    );
    expect(result.current).toBe(false);
    rerender({ key: KEY, remaining: 300 });
    expect(result.current).toBe(true);
  });

  it.each([
    ["the first time", null],
    ["while credits are only going down", "320"],
    ["with nothing new since last time", "300"],
  ])("does not animate %s", (_case, lastSeen) => {
    if (lastSeen !== null) localStorage.setItem(KEY, lastSeen);
    const { result } = renderHook(() => useRefillAnimation(KEY, 300));
    expect(result.current).toBe(false);
  });

  it("does not animate when reduced motion is on", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
    } as MediaQueryList);
    localStorage.setItem(KEY, "12");
    const { result } = renderHook(() => useRefillAnimation(KEY, 300));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("300");
  });

  it("neither reads nor writes while the meter is loading", () => {
    localStorage.setItem(KEY, "12");
    const { result } = renderHook(() => useRefillAnimation(null, null));
    expect(result.current).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("12");
  });
});
