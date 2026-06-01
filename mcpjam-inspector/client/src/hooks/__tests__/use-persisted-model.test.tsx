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

  // Regression for the host-switch column-count drift. When the picker
  // calls `setSelectedModel(match)` during the apply-host-defaults
  // effect, that routes through `setSelectedModelId`. Pre-fix the
  // setter prepended the new id onto the compare array, growing the
  // column count from 2 to 3 (or, when the new id was already in the
  // array, leaving it at 2 but reordering it). The lead-only contract
  // means the array must stay exactly as it was; rotation belongs to
  // `replaceLeadModelId`.
  it("setSelectedModelId only updates the lead and never mutates the compare array", () => {
    saveSelectedModelId("haiku");
    saveSelectedModelIds(["haiku", "sonnet"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["haiku", "sonnet"]);

    // New id not in the array — pre-fix this grew the array to length 3.
    act(() => {
      result.current.setSelectedModelId("gpt-5-nano");
    });
    expect(result.current.selectedModelId).toBe("gpt-5-nano");
    expect(result.current.selectedModelIds).toEqual(["haiku", "sonnet"]);

    // Existing non-lead id — pre-fix this reordered the array.
    act(() => {
      result.current.setSelectedModelId("sonnet");
    });
    expect(result.current.selectedModelId).toBe("sonnet");
    expect(result.current.selectedModelIds).toEqual(["haiku", "sonnet"]);
  });

  // End-to-end host-switch simulation: setter then storage primitive.
  it("preserves column count across a host switch that calls setSelectedModelId then replaceLeadModelId", () => {
    saveSelectedModelId("haiku");
    saveSelectedModelIds(["haiku", "sonnet"]);

    const { result } = renderHook(() => usePersistedModel());
    expect(result.current.selectedModelIds).toEqual(["haiku", "sonnet"]);

    // applyHostConfigToPlayground writes through replaceLeadModelId
    // first (preserves count, rotates lead), then the in-tab effect
    // calls setSelectedModel(match) → setSelectedModelId. Both orders
    // must leave the column count at 2.
    act(() => {
      replaceLeadModelId("gpt-5-nano");
      result.current.setSelectedModelId("gpt-5-nano");
    });

    expect(result.current.selectedModelId).toBe("gpt-5-nano");
    expect(result.current.selectedModelIds).toEqual(["gpt-5-nano", "sonnet"]);
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
