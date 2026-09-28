import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { usePersistedBoolean } from "@/hooks/use-persisted-boolean";

const KEY = "test.persisted-boolean";

afterEach(() => {
  window.localStorage.removeItem(KEY);
  // Teardown has to run even when an assertion throws first. A storage spy
  // left installed by a failing test would silently mock storage for every
  // test after it, turning one real failure into a cascade of fake ones.
  vi.restoreAllMocks();
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

  it("falls back to the default for a missing or unparseable value", () => {
    expect(
      renderHook(() => usePersistedBoolean(KEY, true)).result.current[0],
    ).toBe(true);

    window.localStorage.setItem(KEY, "maybe");
    expect(
      renderHook(() => usePersistedBoolean(KEY, false)).result.current[0],
    ).toBe(false);
  });

  it("does not write during render — only the committed value is persisted", () => {
    const writes: Array<[string, string]> = [];
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        writes.push([String(key), String(value)]);
      });

    const { result } = renderHook(() => usePersistedBoolean(KEY, true));
    // Mounting mirrors nothing: the value came out of storage (or the default).
    expect(writes).toHaveLength(0);

    act(() => {
      // A functional update that React may replay must not persist twice with
      // a value the UI never committed.
      result.current[1]((prev) => !prev);
    });
    expect(result.current[0]).toBe(false);
    expect(writes).toEqual([[KEY, "false"]]);

    setItem.mockRestore();
  });

  it("writes nothing on a StrictMode mount", () => {
    // The app mounts under `<StrictMode>`, which runs each effect, tears it
    // down, and runs it again on the same mount. The replay must not persist
    // the value that was just read out of storage — otherwise merely opening
    // a screen stamps a preference the reader never chose.
    window.localStorage.setItem(KEY, "false");
    const writes: Array<[string, string]> = [];
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation((key, value) => {
        writes.push([String(key), String(value)]);
      });

    const { result } = renderHook(() => usePersistedBoolean(KEY, true), {
      wrapper: StrictMode,
    });
    expect(result.current[0]).toBe(false);
    expect(writes).toHaveLength(0);

    // A real change still lands.
    act(() => {
      result.current[1](true);
    });
    expect(writes).toEqual([[KEY, "true"]]);

    setItem.mockRestore();
  });

  it("keeps in-memory state when the write fails", () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });

    const { result } = renderHook(() => usePersistedBoolean(KEY, true));
    act(() => {
      result.current[1](false);
    });
    expect(result.current[0]).toBe(false);

    setItem.mockRestore();
  });

  it("survives a getItem that throws", () => {
    const getItem = vi
      .spyOn(window.localStorage, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    const { result } = renderHook(() => usePersistedBoolean(KEY, true));
    expect(result.current[0]).toBe(true);

    getItem.mockRestore();
  });
});
