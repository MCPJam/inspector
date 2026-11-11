/**
 * The hosted pane's picture: blanked between streams, but the last one is
 * kept, bitmap and all, for a desktop that paused.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePaneFrame } from "@/components/browser/usePaneFrame";

function frameWith(seq: number) {
  const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
  return {
    bitmap,
    deviceWidth: 1024,
    deviceHeight: 768,
    scale: 1,
    ts: seq,
    seq,
  };
}

describe("usePaneFrame", () => {
  it("keeps the last picture when the stream blanks, and releases it once replaced", () => {
    const { result } = renderHook(() => usePaneFrame());
    const first = frameWith(1);
    const second = frameWith(2);

    act(() => result.current.show(first));
    act(() => result.current.blank());
    expect(result.current.frame).toBeNull();
    expect(result.current.last).toBe(first);
    expect(first.bitmap.close).not.toHaveBeenCalled();

    act(() => result.current.show(second));
    expect(result.current.frame).toBe(second);
    expect(first.bitmap.close).toHaveBeenCalledOnce();
    expect(second.bitmap.close).not.toHaveBeenCalled();
  });

  it("releases the last picture for another browser, and on unmount", () => {
    const { result, unmount } = renderHook(() => usePaneFrame());
    const first = frameWith(1);
    act(() => result.current.show(first));
    act(() => result.current.forget());
    expect(result.current.last).toBeNull();
    expect(first.bitmap.close).toHaveBeenCalledOnce();

    const second = frameWith(2);
    act(() => result.current.show(second));
    unmount();
    expect(second.bitmap.close).toHaveBeenCalledOnce();
  });
});
