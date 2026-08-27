import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePersistedBoolean } from "@/hooks/use-persisted-boolean";

const KEY = "test.persisted-boolean";

afterEach(() => {
  window.localStorage.removeItem(KEY);
});

describe("usePersistedBoolean", () => {
  it("reads and writes localStorage", () => {
    window.localStorage.setItem(KEY, "false");

    const { result } = renderHook(() => usePersistedBoolean(KEY, true));
    expect(result.current[0]).toBe(false);

    act(() => {
      result.current[1](true);
    });
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("true");
  });
});
