import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJsonTreeState } from "../use-json-tree-state";

describe("useJsonTreeState", () => {
  it("does not blow the call stack on deeply nested JSON (INSPECTOR-CLIENT-232)", () => {
    let deep: any = {};
    let cursor = deep;
    for (let i = 0; i < 50_000; i++) {
      cursor.a = {};
      cursor = cursor.a;
    }

    const { result } = renderHook(() =>
      useJsonTreeState({ defaultExpandDepth: 2 }),
    );

    expect(() => {
      act(() => {
        result.current.initializeFromValue(deep);
      });
    }).not.toThrow();

    // Asserts the actual collapse result (not just the absence of a throw):
    // the defensive try/catch in initializeFromValue would otherwise swallow
    // a reintroduced stack overflow and leave collapsedPaths empty, letting
    // this test pass for the wrong reason.
    expect(result.current.collapsedPaths).toEqual(new Set(["root.a.a"]));
  });
});
