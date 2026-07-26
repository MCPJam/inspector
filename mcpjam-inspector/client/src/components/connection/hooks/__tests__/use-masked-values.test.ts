import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMaskedValues } from "../use-masked-values";

describe("useMaskedValues", () => {
  it("masks every row by default", () => {
    const { result } = renderHook(() => useMaskedValues());

    expect(result.current.isVisible(0)).toBe(false);
    expect(result.current.isVisible(7)).toBe(false);
  });

  it("toggles a single row without touching its neighbours", () => {
    const { result } = renderHook(() => useMaskedValues());

    act(() => result.current.toggle(1));
    expect(result.current.isVisible(0)).toBe(false);
    expect(result.current.isVisible(1)).toBe(true);
    expect(result.current.isVisible(2)).toBe(false);

    act(() => result.current.toggle(1));
    expect(result.current.isVisible(1)).toBe(false);
  });

  it("leaves a freshly added row visible", () => {
    const { result } = renderHook(() => useMaskedValues());

    act(() => result.current.markAdded(3));

    expect(result.current.isVisible(3)).toBe(true);
    expect(result.current.isVisible(2)).toBe(false);
  });

  it("slides overrides down when a row below them is dropped", () => {
    const { result } = renderHook(() => useMaskedValues());

    act(() => result.current.toggle(2));
    // Row 1 goes away, so what was row 2 is now row 1 and must carry the eye
    // state with it — otherwise it lands on a value the user had hidden.
    act(() => result.current.dropAt(1));

    expect(result.current.isVisible(1)).toBe(true);
    expect(result.current.isVisible(2)).toBe(false);
  });

  it("leaves overrides below the dropped row alone", () => {
    const { result } = renderHook(() => useMaskedValues());

    act(() => result.current.toggle(0));
    act(() => result.current.dropAt(2));

    expect(result.current.isVisible(0)).toBe(true);
  });

  it("forgets the override for the row that was dropped", () => {
    const { result } = renderHook(() => useMaskedValues());

    act(() => result.current.toggle(1));
    act(() => result.current.dropAt(1));

    expect(result.current.isVisible(1)).toBe(false);
  });

  it("re-masks everything when the subject changes", () => {
    // A form that swaps servers without remounting keeps this hook. Overrides
    // are positional, so "row 1 is visible" would otherwise land on whatever
    // the next server has at row 1 — a value nobody uncovered.
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useMaskedValues(key),
      { initialProps: { key: "server-a" } }
    );

    act(() => result.current.toggle(1));
    expect(result.current.isVisible(1)).toBe(true);

    rerender({ key: "server-b" });

    expect(result.current.isVisible(1)).toBe(false);
  });

  it("leaves overrides alone while the subject holds", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useMaskedValues(key),
      { initialProps: { key: "server-a" } }
    );

    act(() => result.current.toggle(0));
    rerender({ key: "server-a" });

    expect(result.current.isVisible(0)).toBe(true);
  });

  it("keeps rows masked no matter how many arrive at once", () => {
    const { result } = renderHook(() => useMaskedValues());

    // A reveal drops the whole stored set in at once. That click asked which
    // values are set, not to read them, so nothing may unmask itself — only a
    // row's own eye can.
    expect(result.current.isVisible(0)).toBe(false);
    expect(result.current.isVisible(4)).toBe(false);

    act(() => result.current.toggle(2));
    expect(result.current.isVisible(2)).toBe(true);
    expect(result.current.isVisible(0)).toBe(false);
    expect(result.current.isVisible(4)).toBe(false);
  });
});
