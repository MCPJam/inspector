import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { usePersistedString } from "@/hooks/use-persisted-string";

const KEY = "test.persisted-string";
const DEFAULT = "http://localhost:3000";

afterEach(() => {
  window.localStorage.removeItem(KEY);
  vi.restoreAllMocks();
});

describe("usePersistedString", () => {
  it("reads and writes localStorage", () => {
    window.localStorage.setItem(KEY, "https://shop.test/");

    const { result } = renderHook(() => usePersistedString(KEY, DEFAULT));
    expect(result.current[0]).toBe("https://shop.test/");

    act(() => {
      result.current[1]("https://pizza.test/");
    });
    expect(result.current[0]).toBe("https://pizza.test/");
    expect(window.localStorage.getItem(KEY)).toBe("https://pizza.test/");
  });

  it("falls back to the default for a missing or blank value", () => {
    expect(
      renderHook(() => usePersistedString(KEY, DEFAULT)).result.current[0],
    ).toBe(DEFAULT);

    window.localStorage.setItem(KEY, "   ");
    expect(
      renderHook(() => usePersistedString(KEY, DEFAULT)).result.current[0],
    ).toBe(DEFAULT);
  });

  it("writes nothing on a StrictMode mount", () => {
    window.localStorage.setItem(KEY, "https://shop.test/");
    const writes: Array<[string, string]> = [];
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        writes.push([String(key), String(value)]);
      });

    const { result } = renderHook(() => usePersistedString(KEY, DEFAULT), {
      wrapper: StrictMode,
    });
    expect(result.current[0]).toBe("https://shop.test/");
    expect(writes).toHaveLength(0);

    act(() => {
      result.current[1]("https://pizza.test/");
    });
    expect(writes).toEqual([[KEY, "https://pizza.test/"]]);

    setItem.mockRestore();
  });

  it("keeps in-memory state when the write fails", () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });

    const { result } = renderHook(() => usePersistedString(KEY, DEFAULT));
    act(() => {
      result.current[1]("https://pizza.test/");
    });
    expect(result.current[0]).toBe("https://pizza.test/");

    setItem.mockRestore();
  });

  it("survives a getItem that throws", () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    const { result } = renderHook(() => usePersistedString(KEY, DEFAULT));
    expect(result.current[0]).toBe(DEFAULT);

    getItem.mockRestore();
  });
});
