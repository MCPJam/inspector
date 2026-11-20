import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCompareBroadcast } from "../compare-broadcast";
import { useCompareAutoRun } from "../use-compare-auto-run";

describe("useCompareAutoRun", () => {
  const setup = (queued: boolean) => {
    const onSent = vi.fn();
    const { result } = renderHook(() => useCompareAutoRun(onSent));
    const sequence = { current: 0 };
    let turn: { text: string } | null = null;
    result.current.queueRef.current = (t) => {
      if (!queued) return false;
      turn = t;
      sequence.current += 1;
      return true;
    };
    return { result, onSent, sequence, queued: () => turn };
  };

  it("reports sent only once a lane claims the broadcast", async () => {
    const { result, onSent, sequence, queued } = setup(true);
    const onDeferred = vi.fn();
    await act(() =>
      result.current.send("Hi", [], {
        gate: async () => true,
        sequence,
        onDeferred,
        onRefused: vi.fn(),
      }),
    );
    expect(queued()).toMatchObject({ text: "Hi", prependMessages: [] });
    expect(onSent).not.toHaveBeenCalled();
    const request = { id: 1, text: "Hi" } as never;
    const delivery = createCompareBroadcast(request, ["a", "b"]);
    expect(result.current.claim(delivery, request, "a")).toBe(true);
    expect(result.current.claim(delivery, request, "b")).toBe(true);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onDeferred).not.toHaveBeenCalled();
  });

  it("defers when a gate holds the send, and asks for a retry when no lane can take it", async () => {
    const deferred = setup(true);
    const onDeferred = vi.fn();
    await act(() =>
      deferred.result.current.send("Hi", [], {
        gate: async () => false,
        sequence: deferred.sequence,
        onDeferred,
        onRefused: vi.fn(),
      }),
    );
    expect(onDeferred).toHaveBeenCalled();
    expect(deferred.queued()).toBeNull();

    const refused = setup(false);
    const onRefused = vi.fn();
    await act(() =>
      refused.result.current.send("Hi", [], {
        gate: async () => true,
        sequence: refused.sequence,
        onDeferred: vi.fn(),
        onRefused,
      }),
    );
    expect(onRefused).toHaveBeenCalled();
  });
});
