import { describe, it, expect, vi } from "vitest";
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

    // A stack overflow while deriving the initial state throws out of the
    // render, failing this line.
    const { result } = renderHook(() =>
      useJsonTreeState({ value: deep, defaultExpandDepth: 2 }),
    );

    // Asserts the actual collapse result, not just the absence of a throw.
    expect(result.current.collapsedPaths.size).toBeGreaterThan(0);
  });

  it("tells the parent about the derived collapse state after commit", () => {
    const onCollapseChange = vi.fn();

    renderHook(() =>
      useJsonTreeState({
        value: deeplyNested(6),
        defaultExpandDepth: 2,
        onCollapseChange,
      }),
    );

    expect(onCollapseChange).toHaveBeenCalledTimes(1);
    expect(onCollapseChange.mock.calls[0][0].size).toBe(4);
  });

  it("collapses every container below the expand depth so drilling in reveals one level at a time", () => {
    const { result } = renderHook(() =>
      useJsonTreeState({ value: deeplyNested(6), defaultExpandDepth: 2 }),
    );

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
      useJsonTreeState({ value: deeplyNested(50_000), defaultExpandDepth: 2 }),
    );

    // Depths 2 through the cap (100), inclusive.
    expect(result.current.collapsedPaths.size).toBe(99);
    expect(result.current.isCollapsed(`root${".a".repeat(100)}`)).toBe(true);
    expect(result.current.isCollapsed(`root${".a".repeat(101)}`)).toBe(false);
  });

  it("skips holes in a sparse array instead of throwing", () => {
    // A hole, not an undefined element: the walk must not try to descend it.
    const sparse: unknown[] = new Array(3);
    sparse[0] = { a: 1 };
    sparse[2] = { b: 2 };

    const { result } = renderHook(() =>
      useJsonTreeState({ value: { list: sparse }, defaultExpandDepth: 1 }),
    );

    expect(result.current.collapsedPaths).toEqual(
      new Set(["root.list", "root.list.0", "root.list.2"]),
    );
  });

  it("collapseAll collapses every container through the scan cap", () => {
    const { result } = renderHook(() => useJsonTreeState({}));

    act(() => {
      result.current.collapseAll(deeplyNested(50_000));
    });

    expect(result.current.isCollapsed("root")).toBe(true);
    expect(result.current.isCollapsed("root.a")).toBe(true);
    // Depths 0 through the cap (100), inclusive.
    expect(result.current.collapsedPaths.size).toBe(101);
    expect(result.current.isCollapsed(`root${".a".repeat(100)}`)).toBe(true);
    expect(result.current.isCollapsed(`root${".a".repeat(101)}`)).toBe(false);
  });
});
