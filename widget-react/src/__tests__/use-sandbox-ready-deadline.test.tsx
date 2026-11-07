import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_READY_TIMEOUT_MS, useSandboxReadyDeadline } from "../use-sandbox-ready-deadline";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("sandbox readiness deadline", () => {
  it("reports a missing proxy handshake once without retrying", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    renderHook(() => useSandboxReadyDeadline({ waiting: true, identity: "app", onTimeout }));
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS - 1));
    expect(onTimeout).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onTimeout).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancels on readiness and gives a different app its own deadline", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const { rerender } = renderHook(({ waiting, identity }) => useSandboxReadyDeadline({ waiting, identity, onTimeout }), {
      initialProps: { waiting: true, identity: "first" },
    });
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS / 2));
    rerender({ waiting: false, identity: "first" });
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS));
    expect(onTimeout).not.toHaveBeenCalled();
    rerender({ waiting: true, identity: "second" });
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS));
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not extend the deadline when the callback rerenders", () => {
    vi.useFakeTimers();
    const first = vi.fn();
    const next = vi.fn();
    const { rerender } = renderHook(({ onTimeout }) => useSandboxReadyDeadline({ waiting: true, identity: "app", onTimeout }), {
      initialProps: { onTimeout: first },
    });
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS / 2));
    rerender({ onTimeout: next });
    act(() => vi.advanceTimersByTime(SANDBOX_READY_TIMEOUT_MS / 2));
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
