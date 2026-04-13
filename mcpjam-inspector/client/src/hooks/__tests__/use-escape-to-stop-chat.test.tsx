import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useEscapeToStopChat } from "../use-escape-to-stop-chat";

describe("useEscapeToStopChat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires on plain Escape when enabled", () => {
    const onStop = vi.fn();

    renderHook(() => useEscapeToStopChat({ enabled: true, onStop }));

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores non-Escape keys", () => {
    const onStop = vi.fn();

    renderHook(() => useEscapeToStopChat({ enabled: true, onStop }));

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores repeated Escape presses", () => {
    const onStop = vi.fn();

    renderHook(() => useEscapeToStopChat({ enabled: true, onStop }));

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(onStop).not.toHaveBeenCalled();
  });

  it("ignores already-prevented Escape events", () => {
    const onStop = vi.fn();
    const preventEscape = (event: KeyboardEvent) => {
      event.preventDefault();
    };

    window.addEventListener("keydown", preventEscape, true);
    renderHook(() => useEscapeToStopChat({ enabled: true, onStop }));

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);
    window.removeEventListener("keydown", preventEscape, true);

    expect(onStop).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("removes the keydown listener on unmount", () => {
    const onStop = vi.fn();
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { unmount } = renderHook(() =>
      useEscapeToStopChat({ enabled: true, onStop }),
    );

    unmount();
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      "keydown",
      expect.any(Function),
    );
    expect(onStop).not.toHaveBeenCalled();
  });

  it("keeps the listener stable when onStop changes and calls the latest callback", () => {
    const firstOnStop = vi.fn();
    const secondOnStop = vi.fn();
    const addEventListenerSpy = vi.spyOn(window, "addEventListener");
    const removeEventListenerSpy = vi.spyOn(window, "removeEventListener");

    const { rerender } = renderHook(
      ({ onStop }) => useEscapeToStopChat({ enabled: true, onStop }),
      {
        initialProps: { onStop: firstOnStop },
      },
    );

    const keydownAddsAfterMount = addEventListenerSpy.mock.calls.filter(
      ([type]) => type === "keydown",
    ).length;
    const keydownRemovesAfterMount = removeEventListenerSpy.mock.calls.filter(
      ([type]) => type === "keydown",
    ).length;

    rerender({ onStop: secondOnStop });

    expect(
      addEventListenerSpy.mock.calls.filter(([type]) => type === "keydown")
        .length,
    ).toBe(keydownAddsAfterMount);
    expect(
      removeEventListenerSpy.mock.calls.filter(([type]) => type === "keydown")
        .length,
    ).toBe(keydownRemovesAfterMount);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(firstOnStop).not.toHaveBeenCalled();
    expect(secondOnStop).toHaveBeenCalledTimes(1);
  });
});
