import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import {
  measuredShiftDelta,
  shiftNodesY,
  useMeasuredShift,
} from "../measured-shift";

describe("measuredShiftDelta", () => {
  it("is 0 until the card is measured or when there is no estimate", () => {
    expect(measuredShiftDelta(0, 300)).toBe(0);
    expect(measuredShiftDelta(320, null)).toBe(0);
  });

  it("is the measured height minus the estimate, in either direction", () => {
    expect(measuredShiftDelta(340, 300)).toBe(40);
    expect(measuredShiftDelta(280, 300)).toBe(-20);
  });
});

describe("shiftNodesY", () => {
  const card: Node = { id: "card", position: { x: 0, y: 0 }, data: {} };
  const below: Node = { id: "below", position: { x: 10, y: 400 }, data: {} };

  it("returns the same array when dy is 0", () => {
    const nodes = [card, below];
    expect(shiftNodesY(nodes, 0, () => true)).toBe(nodes);
  });

  it("moves the selected nodes down and keeps the rest by reference", () => {
    const [kept, moved] = shiftNodesY(
      [card, below],
      25,
      (node) => node.id === "below",
    );
    expect(kept).toBe(card);
    expect(moved.position).toEqual({ x: 10, y: 425 });
  });
});

describe("useMeasuredShift", () => {
  it("reports the shift once a height arrives and ignores subpixel changes", () => {
    const { result } = renderHook(() => useMeasuredShift(300));
    expect(result.current.dy).toBe(0);

    act(() => result.current.reportHeight(340));
    expect(result.current.dy).toBe(40);

    act(() => result.current.reportHeight(340.3));
    expect(result.current.dy).toBe(40);

    act(() => result.current.reportHeight(352));
    expect(result.current.dy).toBe(52);
  });

  it("keeps reportHeight stable across renders", () => {
    const { result, rerender } = renderHook(() => useMeasuredShift(300));
    const first = result.current.reportHeight;
    rerender();
    expect(result.current.reportHeight).toBe(first);
  });
});
