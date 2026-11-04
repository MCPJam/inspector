import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConformanceDeadline } from "../use-conformance-deadline";

afterEach(() => vi.useRealTimers());

describe("shared conformance deadline", () => {
  it("shares one shrinking budget across suites and expires once", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const { result } = renderHook(() => useConformanceDeadline(expire));
    act(() => result.current.start(300));
    const first = result.current.budget();
    expect(first.remainingRunTimeoutMs).toBe(300_000);
    act(() => vi.advanceTimersByTime(100_000));
    const second = result.current.budget();
    expect(second.signal).toBe(first.signal);
    expect(second.remainingRunTimeoutMs).toBe(200_000);
    act(() => vi.advanceTimersByTime(200_000));
    expect(expire).toHaveBeenCalledExactlyOnceWith(
      "Run timed out after 300 seconds",
    );
    expect(first.signal?.aborted).toBe(true);
  });
  it("cleans up an early completion and unmount", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const { result, unmount } = renderHook(() =>
      useConformanceDeadline(expire),
    );
    act(() => result.current.start(1));
    act(() => result.current.clear());
    act(() => vi.advanceTimersByTime(1_000));
    expect(expire).not.toHaveBeenCalled();
    act(() => result.current.start(1));
    const signal = result.current.budget().signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("replaces a prior run and leaves an unset limit unchanged", () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const { result } = renderHook(() => useConformanceDeadline(expire));
    act(() => result.current.start(1));
    const old = result.current.budget().signal;
    act(() => result.current.start(undefined));
    expect(old?.aborted).toBe(true);
    expect(result.current.budget()).toEqual({});
    expect(result.current.runTimeoutSeconds).toBeUndefined();
    act(() => vi.advanceTimersByTime(300_000));
    expect(expire).not.toHaveBeenCalled();
  });
  it.each([0, 301, 1.5, NaN])("rejects invalid timeout %s", (seconds) => {
    const { result } = renderHook(() => useConformanceDeadline(vi.fn()));
    expect(() => act(() => result.current.start(seconds))).toThrow("1 to 300");
  });
});
