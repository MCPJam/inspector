import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useModelSelectorLayoutLock } from "../use-model-selector-layout-lock";

describe("useModelSelectorLayoutLock", () => {
  it("preserves the single-model layout while the selector stays open", () => {
    const { result, rerender } = renderHook(
      ({ isMultiModelMode }) => useModelSelectorLayoutLock(isMultiModelMode),
      {
        initialProps: { isMultiModelMode: false },
      },
    );

    act(() => {
      result.current.onModelSelectorOpenChange(true);
    });

    rerender({ isMultiModelMode: true });

    expect(result.current.isMultiModelLayoutMode).toBe(false);

    act(() => {
      result.current.onModelSelectorOpenChange(false);
    });

    expect(result.current.isMultiModelLayoutMode).toBe(true);
  });

  it("preserves the multi-model layout while the selector stays open", () => {
    const { result, rerender } = renderHook(
      ({ isMultiModelMode }) => useModelSelectorLayoutLock(isMultiModelMode),
      {
        initialProps: { isMultiModelMode: true },
      },
    );

    act(() => {
      result.current.onModelSelectorOpenChange(true);
    });

    rerender({ isMultiModelMode: false });

    expect(result.current.isMultiModelLayoutMode).toBe(true);

    act(() => {
      result.current.onModelSelectorOpenChange(false);
    });

    expect(result.current.isMultiModelLayoutMode).toBe(false);
  });
});
