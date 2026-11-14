import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMultiModelPositions } from "../use-multi-model-positions";

describe("useMultiModelPositions", () => {
  it("never reuses a position, even for a replaced column", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    expect(result.current.positionFor("model:a")).toBe(0);
    expect(result.current.positionFor("model:b")).toBe(1);
    expect(result.current.positionFor("model:a")).toBe(0);
    // A new effort is a new column key, so it gets the next position.
    expect(result.current.positionFor("model:a-high")).toBe(2);
  });

  it("continues after a restored session's highest position", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    result.current.seed("g", [{ columnKey: "model:a", position: 3 }], 5);
    expect(result.current.positionFor("model:a")).toBe(3);
    expect(result.current.positionFor("model:new")).toBe(6);
  });

  it("starts over for a new group", () => {
    const { result, rerender } = renderHook(({ id }) => useMultiModelPositions(id), {
      initialProps: { id: "g1" },
    });
    result.current.positionFor("model:a");
    rerender({ id: "g2" });
    expect(result.current.positionFor("model:b")).toBe(0);
  });
});
