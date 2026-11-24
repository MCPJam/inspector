import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMultiModelPositions } from "../use-multi-model-positions";

describe("useMultiModelPositions", () => {
  it("keeps a column's position while it stays and never reuses one", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    expect(result.current.positionFor("model:a")).toBe(0);
    expect(result.current.positionFor("model:b")).toBe(1);
    expect(result.current.positionFor("model:a")).toBe(0);
    // A new effort is a new column key, so it gets the next position.
    expect(result.current.positionFor("model:a-high")).toBe(2);
  });

  it("gives a column removed and added back a new position", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    result.current.positionFor("model:a");
    result.current.positionFor("model:b");
    result.current.syncLiveColumns(["model:a", "model:b"]);
    result.current.syncLiveColumns(["model:b"]);
    expect(result.current.positionFor("model:a")).toBe(2);
    expect(result.current.positionFor("model:b")).toBe(1);
  });

  it("continues after a restored session's highest position", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    result.current.seed("g", [{ columnKey: "model:a", position: 3 }], 5);
    expect(result.current.positionFor("model:a")).toBe(3);
    expect(result.current.positionFor("model:new")).toBe(6);
  });

  it("keeps a seeded position until its column has shown", () => {
    const { result } = renderHook(() => useMultiModelPositions("g"));
    result.current.syncLiveColumns(["model:old"]);
    result.current.seed("g", [{ columnKey: "model:a", position: 3 }], 5);
    // The old lineup leaves before the restored one shows.
    result.current.syncLiveColumns([]);
    expect(result.current.positionFor("model:a")).toBe(3);
  });

  it("starts over for a new group", () => {
    const { result, rerender } = renderHook(
      ({ id }) => useMultiModelPositions(id),
      { initialProps: { id: "g1" } },
    );
    result.current.positionFor("model:a");
    rerender({ id: "g2" });
    expect(result.current.positionFor("model:b")).toBe(0);
  });
});
