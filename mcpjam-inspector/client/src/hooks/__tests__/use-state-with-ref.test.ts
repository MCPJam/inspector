import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStateWithRef } from "../use-state-with-ref";

describe("useStateWithRef", () => {
  it("updates the ref as soon as the setter runs, before the render", () => {
    const { result } = renderHook(() => useStateWithRef("a"));
    const [, set, ref] = result.current;
    act(() => {
      set("b");
      expect(ref.current).toBe("b");
    });
    expect(result.current[0]).toBe("b");
  });

  it("keeps the same setter and ref across renders", () => {
    const { result, rerender } = renderHook(() => useStateWithRef(0));
    const [, set, ref] = result.current;
    rerender();
    expect(result.current[1]).toBe(set);
    expect(result.current[2]).toBe(ref);
  });
});
