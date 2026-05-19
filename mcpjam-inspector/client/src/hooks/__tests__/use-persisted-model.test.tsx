import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePersistedModel } from "../use-persisted-model";
import {
  loadSelectedModelId,
  loadSelectedModelIds,
  replaceLeadModelId,
  saveSelectedModelId,
  saveSelectedModelIds,
} from "@/lib/selected-model-storage";

describe("usePersistedModel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // Regression for PR #2171 follow-up. Reproduces the exact sequence
  // emitted by PlaygroundMain's `handleSelectedModelsChange` when the
  // user toggles ON multi-model with Haiku already selected and clicks
  // a second row (Sonnet): we first re-affirm the lead, then write the
  // longer array. Pre-PR this added the second model; we must not
  // regress that.
  it("adds a second model when handleSelectedModelsChange affirms the existing lead then writes a longer array", () => {
    saveSelectedModelId("a");
    saveSelectedModelIds(["a"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["a"]);

    act(() => {
      // Step 1: re-affirm existing lead (the picker always sends the
      // current lead at slot 0, so handleSelectedModelsChange calls
      // setSelectedModel for it before setSelectedModelIds).
      result.current.setSelectedModelId("a");
      // Step 2: write the new compare array including the new model.
      result.current.setSelectedModelIds(["a", "b"]);
    });

    expect(result.current.selectedModelIds).toEqual(["a", "b"]);
    expect(result.current.selectedModelId).toBe("a");
    expect(loadSelectedModelIds()).toEqual(["a", "b"]);
    expect(loadSelectedModelId()).toBe("a");
  });

  it("removes a model when setSelectedModelIds shrinks the array", () => {
    saveSelectedModelId("a");
    saveSelectedModelIds(["a", "b"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["a", "b"]);

    act(() => {
      result.current.setSelectedModelIds(["a"]);
    });

    expect(result.current.selectedModelIds).toEqual(["a"]);
    expect(loadSelectedModelIds()).toEqual(["a"]);
  });

  it("promotes a non-lead model to lead via setSelectedModelId (compare reorder)", () => {
    saveSelectedModelId("a");
    saveSelectedModelIds(["a", "b"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["a", "b"]);

    act(() => {
      result.current.setSelectedModelId("b");
    });

    expect(result.current.selectedModelId).toBe("b");
    expect(result.current.selectedModelIds).toEqual(["b", "a"]);
  });

  it("syncs React state when an outside seam calls replaceLeadModelId (host-switch fix)", () => {
    saveSelectedModelId("a");
    saveSelectedModelIds(["a", "extra"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["a", "extra"]);

    // Simulate the playground "apply host defaults" helper switching
    // the lead from "a" to "z" while a second column ("extra") is set.
    act(() => {
      replaceLeadModelId("z");
    });

    expect(result.current.selectedModelId).toBe("z");
    // Column count is preserved; slot 1 untouched.
    expect(result.current.selectedModelIds).toEqual(["z", "extra"]);
  });
});
