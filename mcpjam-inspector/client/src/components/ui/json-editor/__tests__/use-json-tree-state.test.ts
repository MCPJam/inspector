import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJsonTreeState } from "../use-json-tree-state";

function deeplyNested(levels: number): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < levels; i++) {
    const next: Record<string, unknown> = {};
    cursor.a = next;
    cursor = next;
  }
  return root;
}

describe("useJsonTreeState", () => {
  it("does not blow the call stack on deeply nested JSON (INSPECTOR-CLIENT-232)", () => {
    const deep = deeplyNested(50_000);

    const { result } = renderHook(() =>
      useJsonTreeState({ defaultExpandDepth: 2 }),
    );

    expect(() => {
      act(() => {
        result.current.initializeFromValue(deep);
      });
    }).not.toThrow();

    // Asserts the actual collapse result, not just the absence of a throw.
    expect(result.current.collapsedPaths.size).toBeGreaterThan(0);
  });

  it("collapses every container below the expand depth so drilling in reveals one level at a time", () => {
    const { result } = renderHook(() =>
      useJsonTreeState({ defaultExpandDepth: 2 }),
    );

    act(() => {
      result.current.initializeFromValue(deeplyNested(6));
    });

    expect(result.current.isCollapsed("root")).toBe(false);
    expect(result.current.isCollapsed("root.a")).toBe(false);
    // The boundary node and every descendant below it start collapsed. Without
    // the descendants, expanding the boundary dumps the whole subtree at once.
    expect(result.current.isCollapsed("root.a.a")).toBe(true);
    expect(result.current.isCollapsed("root.a.a.a")).toBe(true);
    expect(result.current.isCollapsed("root.a.a.a.a")).toBe(true);
    // The innermost object is empty, so it is not collapsible.
    expect(result.current.collapsedPaths.size).toBe(4);
  });

  it("stops enumerating collapse paths past the scan cap so path memory stays bounded", () => {
    const { result } = renderHook(() =>
      useJsonTreeState({ defaultExpandDepth: 2 }),
    );

    act(() => {
      result.current.initializeFromValue(deeplyNested(50_000));
    });

    // Depths 2 through the cap (100), inclusive.
    expect(result.current.collapsedPaths.size).toBe(99);
    expect(result.current.isCollapsed(`root${".a".repeat(100)}`)).toBe(true);
    expect(result.current.isCollapsed(`root${".a".repeat(101)}`)).toBe(false);
  });
});
