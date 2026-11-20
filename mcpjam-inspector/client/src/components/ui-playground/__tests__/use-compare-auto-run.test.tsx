import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createCompareBroadcast } from "../compare-broadcast";
import { useCompareAutoRun } from "../use-compare-auto-run";

const turn = { text: "Hi", prependMessages: [] };

it("reports the auto-run sent once a lane claims it, not when queued", () => {
  const onSent = vi.fn();
  const { result } = renderHook(() => useCompareAutoRun(onSent));
  const sequence = { current: 0 };
  result.current.queueRef.current = () => {
    sequence.current += 1;
    return true;
  };
  expect(result.current.send(turn, sequence)).toBe(true);
  expect(onSent).not.toHaveBeenCalled();
  const request = { ...turn, id: 1 };
  const delivery = createCompareBroadcast(request, ["a", "b"]);
  expect(result.current.claim(delivery, request, "a")).toBe(true);
  expect(result.current.claim(delivery, request, "b")).toBe(true);
  expect(onSent).toHaveBeenCalledTimes(1);
});

it("refuses when no lane can take the broadcast yet", () => {
  const onSent = vi.fn();
  const { result } = renderHook(() => useCompareAutoRun(onSent));
  expect(result.current.send(turn, { current: 0 })).toBe(false);
  const request = { ...turn, id: 0 };
  result.current.claim(createCompareBroadcast(request, ["a"]), request, "a");
  expect(onSent).not.toHaveBeenCalled();
});
