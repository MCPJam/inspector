import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSelectedModelId,
  loadSelectedModelIds,
  replaceLeadModelId,
  saveSelectedModelId,
  saveSelectedModelIds,
  subscribeSelectedModelId,
} from "../selected-model-storage";

const LEAD_KEY = "mcp-inspector-selected-model";
const ARRAY_KEY = "mcp-inspector-selected-models";

describe("selected-model-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("loadSelectedModelIds / saveSelectedModelIds", () => {
    it("returns [] when nothing is stored", () => {
      expect(loadSelectedModelIds()).toEqual([]);
    });

    it("round-trips a normalized array", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
      expect(localStorage.getItem(ARRAY_KEY)).toBe(JSON.stringify(["a", "b", "c"]));
    });

    it("dedupes, trims, and drops non-strings on save", () => {
      saveSelectedModelIds([
        " a ",
        "a",
        "",
        // @ts-expect-error — exercising runtime normalization
        null,
        "b",
        "b",
      ]);
      expect(loadSelectedModelIds()).toEqual(["a", "b"]);
    });

    it("removes the key when saving an empty array", () => {
      saveSelectedModelIds(["a"]);
      saveSelectedModelIds([]);
      expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
    });

    it("returns [] when the stored JSON is malformed", () => {
      localStorage.setItem(ARRAY_KEY, "{not json");
      expect(loadSelectedModelIds()).toEqual([]);
    });
  });

  describe("replaceLeadModelId", () => {
    it("seeds the array with [newId] when it is currently empty", () => {
      replaceLeadModelId("openai/gpt-5");
      expect(loadSelectedModelId()).toBe("openai/gpt-5");
      expect(loadSelectedModelIds()).toEqual(["openai/gpt-5"]);
    });

    it("is a no-op on the array when newId already sits at index 0", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("a");
      expect(loadSelectedModelId()).toBe("a");
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
    });

    it("rotates an existing id at index k > 0 to the front, preserving count", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("c");
      expect(loadSelectedModelId()).toBe("c");
      // count preserved (3), c moved to slot 0, original order otherwise intact
      expect(loadSelectedModelIds()).toEqual(["c", "a", "b"]);
    });

    it("replaces the lead slot when newId is not in the array, preserving count", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      replaceLeadModelId("z");
      expect(loadSelectedModelId()).toBe("z");
      // count preserved (3); slot 0 replaced, slots 1+ untouched
      expect(loadSelectedModelIds()).toEqual(["z", "b", "c"]);
    });

    it("clears the lead but leaves the array intact when called with null", () => {
      saveSelectedModelIds(["a", "b", "c"]);
      saveSelectedModelId("a");
      replaceLeadModelId(null);
      expect(loadSelectedModelId()).toBeNull();
      expect(loadSelectedModelIds()).toEqual(["a", "b", "c"]);
    });

    it("treats whitespace-only ids like null", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");
      replaceLeadModelId("   ");
      expect(loadSelectedModelId()).toBeNull();
      expect(loadSelectedModelIds()).toEqual(["a", "b"]);
    });

    it("preserves multi-column count when switching hosts (regression for column-drift bug)", () => {
      // Two-column setup in "host A".
      saveSelectedModelIds(["host-a-lead", "extra"]);
      saveSelectedModelId("host-a-lead");

      // Host switch to "host B" with a different default lead.
      replaceLeadModelId("host-b-lead");

      // Count stays at 2; new host's lead sits at slot 0; second column
      // (the workspace preference) is preserved.
      const ids = loadSelectedModelIds();
      expect(ids.length).toBe(2);
      expect(ids[0]).toBe("host-b-lead");
      expect(ids[1]).toBe("extra");
      expect(loadSelectedModelId()).toBe("host-b-lead");
    });
  });

  describe("subscribeSelectedModelId", () => {
    it("fires the callback when the lead is saved", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      saveSelectedModelId("openai/gpt-5");
      expect(cb).toHaveBeenCalled();
      unsubscribe();
    });

    it("fires the callback when the array is saved", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      saveSelectedModelIds(["a", "b"]);
      expect(cb).toHaveBeenCalled();
      unsubscribe();
    });

    it("fires the callback once per replaceLeadModelId, and the read after the event sees both keys updated", () => {
      saveSelectedModelIds(["a", "b"]);
      saveSelectedModelId("a");

      let observedLead: string | null | undefined;
      let observedArray: string[] | undefined;
      const cb = vi.fn(() => {
        observedLead = loadSelectedModelId();
        observedArray = loadSelectedModelIds();
      });
      const unsubscribe = subscribeSelectedModelId(cb);

      // "c" isn't in the array, so the lead slot is replaced; count
      // (2) is preserved — that's the column-drift fix.
      replaceLeadModelId("c");

      // Subscriber receives an event and re-reads both lead and array
      // — and sees a consistent snapshot (both updated together).
      expect(cb).toHaveBeenCalledTimes(1);
      expect(observedLead).toBe("c");
      expect(observedArray).toEqual(["c", "b"]);

      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedModelId(cb);
      unsubscribe();
      saveSelectedModelId("anything");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
