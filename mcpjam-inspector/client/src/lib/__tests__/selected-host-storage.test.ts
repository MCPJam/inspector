import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSelectedHostIds,
  replaceLeadHostId,
  saveSelectedHostIds,
  subscribeSelectedHostIds,
} from "../selected-host-storage";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "../previewed-client-storage";

const ARRAY_KEY = "mcp-inspector-selected-hosts";
const PROJECT = "p1";

describe("selected-host-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("loadSelectedHostIds / saveSelectedHostIds", () => {
    it("returns [] when nothing is stored", () => {
      expect(loadSelectedHostIds()).toEqual([]);
    });

    it("round-trips a normalized array", () => {
      saveSelectedHostIds(["a", "b", "c"]);
      expect(loadSelectedHostIds()).toEqual(["a", "b", "c"]);
      expect(localStorage.getItem(ARRAY_KEY)).toBe(
        JSON.stringify(["a", "b", "c"]),
      );
    });

    it("dedupes, trims, and drops non-strings on save", () => {
      saveSelectedHostIds([
        " a ",
        "a",
        "",
        // @ts-expect-error — exercising runtime normalization
        null,
        "b",
        "b",
      ]);
      expect(loadSelectedHostIds()).toEqual(["a", "b"]);
    });

    it("removes the key when saving an empty array", () => {
      saveSelectedHostIds(["a"]);
      saveSelectedHostIds([]);
      expect(localStorage.getItem(ARRAY_KEY)).toBeNull();
    });

    it("returns [] when the stored JSON is malformed", () => {
      localStorage.setItem(ARRAY_KEY, "{not json");
      expect(loadSelectedHostIds()).toEqual([]);
    });
  });

  describe("replaceLeadHostId", () => {
    it("seeds the array with [newHostId] when it is currently empty", () => {
      replaceLeadHostId(PROJECT, "host-a");
      expect(loadPreviewedHostId(PROJECT)).toBe("host-a");
      expect(loadSelectedHostIds()).toEqual(["host-a"]);
    });

    it("is a no-op on the array when newHostId already sits at index 0", () => {
      saveSelectedHostIds(["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "a");
      expect(loadPreviewedHostId(PROJECT)).toBe("a");
      expect(loadSelectedHostIds()).toEqual(["a", "b", "c"]);
    });

    it("rotates an existing id at index k > 0 to the front, preserving count", () => {
      saveSelectedHostIds(["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "c");
      expect(loadPreviewedHostId(PROJECT)).toBe("c");
      expect(loadSelectedHostIds()).toEqual(["c", "a", "b"]);
    });

    it("replaces the lead slot when newHostId is not in the array, preserving count", () => {
      saveSelectedHostIds(["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "z");
      expect(loadPreviewedHostId(PROJECT)).toBe("z");
      expect(loadSelectedHostIds()).toEqual(["z", "b", "c"]);
    });

    it("clears the lead but leaves the array intact when called with null", () => {
      saveSelectedHostIds(["a", "b", "c"]);
      savePreviewedHostId(PROJECT, "a");
      replaceLeadHostId(PROJECT, null);
      expect(loadPreviewedHostId(PROJECT)).toBeNull();
      expect(loadSelectedHostIds()).toEqual(["a", "b", "c"]);
    });

    it("treats whitespace-only ids like null", () => {
      saveSelectedHostIds(["a", "b"]);
      savePreviewedHostId(PROJECT, "a");
      replaceLeadHostId(PROJECT, "   ");
      expect(loadPreviewedHostId(PROJECT)).toBeNull();
      expect(loadSelectedHostIds()).toEqual(["a", "b"]);
    });

    it("keeps lead and array aligned after a switch", () => {
      saveSelectedHostIds(["a"]);
      savePreviewedHostId(PROJECT, "a");

      replaceLeadHostId(PROJECT, "b");
      // Lead in the per-project previewed-host storage is "b" and the
      // array starts with "b".
      expect(loadPreviewedHostId(PROJECT)).toBe("b");
      const ids = loadSelectedHostIds();
      expect(ids[0]).toBe("b");
    });

    it("preserves multi-column count when switching hosts (regression for column-drift bug)", () => {
      saveSelectedHostIds(["host-a", "extra"]);
      savePreviewedHostId(PROJECT, "host-a");

      replaceLeadHostId(PROJECT, "host-b");

      const ids = loadSelectedHostIds();
      expect(ids.length).toBe(2);
      expect(ids[0]).toBe("host-b");
      expect(ids[1]).toBe("extra");
      expect(loadPreviewedHostId(PROJECT)).toBe("host-b");
    });
  });

  describe("subscribeSelectedHostIds", () => {
    it("does NOT fire when only `saveSelectedHostIds` is called (in-app mirror path)", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      saveSelectedHostIds(["a", "b"]);
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires once on `replaceLeadHostId` and the read after the event sees both keys updated", () => {
      saveSelectedHostIds(["a", "b"]);
      savePreviewedHostId(PROJECT, "a");

      let observedLead: string | null | undefined;
      let observedArray: string[] | undefined;
      const cb = vi.fn(() => {
        observedLead = loadPreviewedHostId(PROJECT);
        observedArray = loadSelectedHostIds();
      });
      const unsubscribe = subscribeSelectedHostIds(cb);

      // "c" isn't in the array, so the lead slot is replaced; count
      // (2) is preserved.
      replaceLeadHostId(PROJECT, "c");

      expect(cb).toHaveBeenCalledTimes(1);
      expect(observedLead).toBe("c");
      expect(observedArray).toEqual(["c", "b"]);

      unsubscribe();
    });

    it("does NOT fire when `replaceLeadHostId` leaves the array untouched (lead already at slot 0)", () => {
      saveSelectedHostIds(["a", "b"]);
      savePreviewedHostId(PROJECT, "a");

      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      // "a" is already at slot 0 — no array change, no array event.
      replaceLeadHostId(PROJECT, "a");
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires on cross-tab `storage` events for the array key", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      // Simulate a cross-tab storage event on the array key.
      window.dispatchEvent(
        new StorageEvent("storage", { key: ARRAY_KEY, newValue: "[]" }),
      );
      expect(cb).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      saveSelectedHostIds(["a"]);
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      unsubscribe();
      replaceLeadHostId(PROJECT, "b");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
