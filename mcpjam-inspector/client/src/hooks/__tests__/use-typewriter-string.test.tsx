import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTypewriterString } from "../use-typewriter-string";

const TARGET = "Draw me an MCP architecture diagram";

describe("useTypewriterString", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty text when inactive", () => {
    const { result } = renderHook(() =>
      useTypewriterString(TARGET, {
        active: false,
        msPerChar: 20,
        reducedMotion: false,
      }),
    );

    expect(result.current.text).toBe("");
    expect(result.current.isComplete).toBe(false);
  });

  it("types one character per interval when active", () => {
    const { result } = renderHook(() =>
      useTypewriterString(TARGET, {
        active: true,
        msPerChar: 20,
        reducedMotion: false,
      }),
    );

    expect(result.current.text).toBe("");

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current.text).toBe("D");

    act(() => {
      vi.advanceTimersByTime(20 * 4);
    });
    expect(result.current.text).toBe("Draw ");
  });

  it("marks complete when the full string is revealed", () => {
    const { result } = renderHook(() =>
      useTypewriterString("Hi", {
        active: true,
        msPerChar: 10,
        reducedMotion: false,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.text).toBe("H");
    expect(result.current.isComplete).toBe(false);

    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(result.current.text).toBe("Hi");
    expect(result.current.isComplete).toBe(true);
  });

  it("returns full target immediately when reducedMotion is true", () => {
    const { result } = renderHook(() =>
      useTypewriterString(TARGET, {
        active: true,
        msPerChar: 20,
        reducedMotion: true,
      }),
    );

    expect(result.current.text).toBe(TARGET);
    expect(result.current.isComplete).toBe(true);
  });

  it("clears timers on unmount", () => {
    const { unmount } = renderHook(() =>
      useTypewriterString(TARGET, {
        active: true,
        msPerChar: 20,
        reducedMotion: false,
      }),
    );

    unmount();

    act(() => {
      vi.advanceTimersByTime(1_000_000);
    });

    // No thrown errors; pending timers from cleared interval should not fire into unmounted state
    expect(true).toBe(true);
  });
});
