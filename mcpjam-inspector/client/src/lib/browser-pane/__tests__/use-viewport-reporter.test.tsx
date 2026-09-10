import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useViewportReporter } from "../use-viewport-reporter";

afterEach(() => vi.useRealTimers());
it("uses shared bounds and cancels an obsolete pending size when returning to the sent size", async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const { result } = renderHook(() => useViewportReporter(send, "session"));
  act(() => result.current({ width: 200, height: 100 }));
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(send).toHaveBeenLastCalledWith({ width: 400, height: 300 });
  act(() => result.current({ width: 900, height: 700 }));
  act(() => result.current({ width: 200, height: 100 }));
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(send).toHaveBeenCalledTimes(1);
});

it("cancels retired generations and reports the same geometry for a new session", async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ generation }) => useViewportReporter(send, generation),
    { initialProps: { generation: 1 } },
  );
  act(() => result.current({ width: 600, height: 700 }));
  rerender({ generation: 2 });
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(send).not.toHaveBeenCalled();
  act(() => result.current({ width: 600, height: 700 }));
  await act(() => vi.advanceTimersByTimeAsync(80));
  rerender({ generation: 3 });
  act(() => result.current({ width: 600, height: 700 }));
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(send).toHaveBeenCalledTimes(2);
  act(() => result.current({ width: 900, height: 700 }));
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(send).toHaveBeenCalledTimes(2);
});
