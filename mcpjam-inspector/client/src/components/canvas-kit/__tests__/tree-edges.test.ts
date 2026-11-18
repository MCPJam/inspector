import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  buildOrthogonalTreePath,
  isFixedEdgeData,
  shiftFixedEdgesY,
} from "../tree-edges";

describe("buildOrthogonalTreePath", () => {
  it("draws a single straight line between vertically aligned endpoints", () => {
    expect(buildOrthogonalTreePath(100, 0, 100, 80, 14)).toBe(
      "M 100 0 L 100 80",
    );
  });

  it("turns at the vertical midpoint with rounded corners toward a target on the right", () => {
    expect(buildOrthogonalTreePath(0, 0, 100, 100, 8)).toBe(
      "M 0 0 L 0 42 Q 0 50 8 50 L 92 50 Q 100 50 100 58 L 100 100",
    );
  });

  it("mirrors the corners toward a target on the left", () => {
    expect(buildOrthogonalTreePath(100, 0, 0, 100, 8)).toBe(
      "M 100 0 L 100 42 Q 100 50 92 50 L 8 50 Q 0 50 0 58 L 0 100",
    );
  });

  it("shrinks the corner to fit a short horizontal run", () => {
    // Half the 10px run caps the 14px radius at 5.
    expect(buildOrthogonalTreePath(0, 0, 10, 100, 14)).toBe(
      "M 0 0 L 0 45 Q 0 50 5 50 L 5 50 Q 10 50 10 55 L 10 100",
    );
  });
});

describe("isFixedEdgeData", () => {
  it("accepts all four numeric endpoints and rejects anything less", () => {
    expect(
      isFixedEdgeData({
        fixedSourceX: 0,
        fixedSourceY: 1,
        fixedTargetX: 2,
        fixedTargetY: 3,
      }),
    ).toBe(true);
    expect(isFixedEdgeData({ fixedSourceX: 0, fixedSourceY: 1 })).toBe(false);
    expect(isFixedEdgeData(undefined)).toBe(false);
  });
});

describe("shiftFixedEdgesY", () => {
  const fixed: Edge = {
    id: "fixed",
    source: "a",
    target: "b",
    data: {
      fixedSourceX: 1,
      fixedSourceY: 10,
      fixedTargetX: 2,
      fixedTargetY: 20,
    },
  };
  const measured: Edge = { id: "measured", source: "a", target: "c" };

  it("returns the same array when dy is 0", () => {
    const edges = [fixed];
    expect(shiftFixedEdgesY(edges, 0, () => true)).toBe(edges);
  });

  it("moves only the Y endpoints of selected fixed edges", () => {
    const [moved, untouched] = shiftFixedEdgesY(
      [fixed, measured],
      5,
      () => true,
    );
    expect(moved.data).toEqual({
      fixedSourceX: 1,
      fixedSourceY: 15,
      fixedTargetX: 2,
      fixedTargetY: 25,
    });
    // An edge without fixed endpoints follows its nodes on its own.
    expect(untouched).toBe(measured);
  });

  it("leaves edges the predicate does not select", () => {
    const [kept] = shiftFixedEdgesY([fixed], 5, (edge) => edge.id !== "fixed");
    expect(kept).toBe(fixed);
  });
});
