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

const PROJECT = "p1";
const PROJECT_B = "p2";
const ARRAY_KEY_P1 = `mcp-inspector-selected-hosts:${PROJECT}`;
const ARRAY_KEY_P2 = `mcp-inspector-selected-hosts:${PROJECT_B}`;

describe("selected-host-storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe("loadSelectedHostIds / saveSelectedHostIds", () => {
    it("returns [] when nothing is stored", () => {
      expect(loadSelectedHostIds(PROJECT)).toEqual([]);
    });

    it("round-trips a normalized array under the project-scoped key", () => {
      saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b", "c"]);
      expect(localStorage.getItem(ARRAY_KEY_P1)).toBe(
        JSON.stringify(["a", "b", "c"]),
      );
    });

    it("dedupes, trims, and drops non-strings on save", () => {
      saveSelectedHostIds(PROJECT, [
        " a ",
        "a",
        "",
        // @ts-expect-error — exercising runtime normalization
        null,
        "b",
        "b",
      ]);
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b"]);
    });

    it("removes the key when saving an empty array", () => {
      saveSelectedHostIds(PROJECT, ["a"]);
      saveSelectedHostIds(PROJECT, []);
      expect(localStorage.getItem(ARRAY_KEY_P1)).toBeNull();
    });

    it("returns [] when the stored JSON is malformed", () => {
      localStorage.setItem(ARRAY_KEY_P1, "{not json");
      expect(loadSelectedHostIds(PROJECT)).toEqual([]);
    });

    it("isolates arrays across projects (no cross-project leakage)", () => {
      saveSelectedHostIds(PROJECT, ["a", "b"]);
      expect(loadSelectedHostIds(PROJECT_B)).toEqual([]);
      saveSelectedHostIds(PROJECT_B, ["x", "y", "z"]);
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b"]);
      expect(loadSelectedHostIds(PROJECT_B)).toEqual(["x", "y", "z"]);
      expect(localStorage.getItem(ARRAY_KEY_P1)).toBe(
        JSON.stringify(["a", "b"]),
      );
      expect(localStorage.getItem(ARRAY_KEY_P2)).toBe(
        JSON.stringify(["x", "y", "z"]),
      );
    });

    // Null projectId is defensive — not reachable through PlaygroundTab
    // (which always passes a non-null projectId). We still guard the
    // storage seam.
    it("loadSelectedHostIds(null) returns [] (defensive; not reachable in practice)", () => {
      saveSelectedHostIds(PROJECT, ["a"]);
      expect(loadSelectedHostIds(null)).toEqual([]);
    });

    it("saveSelectedHostIds(null, …) is a no-op (defensive; not reachable in practice)", () => {
      saveSelectedHostIds(null, ["a", "b"]);
      expect(loadSelectedHostIds(PROJECT)).toEqual([]);
      expect(localStorage.getItem(ARRAY_KEY_P1)).toBeNull();
    });
  });

  describe("replaceLeadHostId", () => {
    it("seeds the array with [newHostId] when it is currently empty", () => {
      replaceLeadHostId(PROJECT, "host-a");
      expect(loadPreviewedHostId(PROJECT)).toBe("host-a");
      expect(loadSelectedHostIds(PROJECT)).toEqual(["host-a"]);
    });

    it("is a no-op on the array when newHostId already sits at index 0", () => {
      saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "a");
      expect(loadPreviewedHostId(PROJECT)).toBe("a");
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b", "c"]);
    });

    it("rotates an existing id at index k > 0 to the front, preserving count", () => {
      saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "c");
      expect(loadPreviewedHostId(PROJECT)).toBe("c");
      expect(loadSelectedHostIds(PROJECT)).toEqual(["c", "a", "b"]);
    });

    it("replaces the lead slot when newHostId is not in the array, preserving count", () => {
      saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
      replaceLeadHostId(PROJECT, "z");
      expect(loadPreviewedHostId(PROJECT)).toBe("z");
      expect(loadSelectedHostIds(PROJECT)).toEqual(["z", "b", "c"]);
    });

    it("clears the lead but leaves the array intact when called with null", () => {
      saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
      savePreviewedHostId(PROJECT, "a");
      replaceLeadHostId(PROJECT, null);
      expect(loadPreviewedHostId(PROJECT)).toBeNull();
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b", "c"]);
    });

    it("treats whitespace-only ids like null", () => {
      saveSelectedHostIds(PROJECT, ["a", "b"]);
      savePreviewedHostId(PROJECT, "a");
      replaceLeadHostId(PROJECT, "   ");
      expect(loadPreviewedHostId(PROJECT)).toBeNull();
      expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b"]);
    });

    it("keeps lead and array aligned after a switch", () => {
      saveSelectedHostIds(PROJECT, ["a"]);
      savePreviewedHostId(PROJECT, "a");

      replaceLeadHostId(PROJECT, "b");
      // Lead in the per-project previewed-host storage is "b" and the
      // array starts with "b".
      expect(loadPreviewedHostId(PROJECT)).toBe("b");
      const ids = loadSelectedHostIds(PROJECT);
      expect(ids[0]).toBe("b");
    });

    it("preserves multi-column count when switching hosts (regression for column-drift bug)", () => {
      saveSelectedHostIds(PROJECT, ["host-a", "extra"]);
      savePreviewedHostId(PROJECT, "host-a");

      replaceLeadHostId(PROJECT, "host-b");

      const ids = loadSelectedHostIds(PROJECT);
      expect(ids.length).toBe(2);
      expect(ids[0]).toBe("host-b");
      expect(ids[1]).toBe("extra");
      expect(loadPreviewedHostId(PROJECT)).toBe("host-b");
    });

    it("scopes array writes to the given projectId", () => {
      saveSelectedHostIds(PROJECT_B, ["other"]);
      replaceLeadHostId(PROJECT, "host-a");
      expect(loadSelectedHostIds(PROJECT)).toEqual(["host-a"]);
      // Project B's array is untouched.
      expect(loadSelectedHostIds(PROJECT_B)).toEqual(["other"]);
    });
  });

  describe("subscribeSelectedHostIds", () => {
    it("does NOT fire when only `saveSelectedHostIds` is called (in-app mirror path)", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      saveSelectedHostIds(PROJECT, ["a", "b"]);
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires once on `replaceLeadHostId` and the read after the event sees both keys updated", () => {
      saveSelectedHostIds(PROJECT, ["a", "b"]);
      savePreviewedHostId(PROJECT, "a");

      let observedLead: string | null | undefined;
      let observedArray: string[] | undefined;
      const cb = vi.fn(() => {
        observedLead = loadPreviewedHostId(PROJECT);
        observedArray = loadSelectedHostIds(PROJECT);
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
      saveSelectedHostIds(PROJECT, ["a", "b"]);
      savePreviewedHostId(PROJECT, "a");

      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      // "a" is already at slot 0 — no array change, no array event.
      replaceLeadHostId(PROJECT, "a");
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("fires on cross-tab `storage` events for any project-scoped array key (prefix match)", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      // Simulate a cross-tab storage event on a project-scoped array key.
      window.dispatchEvent(
        new StorageEvent("storage", { key: ARRAY_KEY_P1, newValue: "[]" }),
      );
      expect(cb).toHaveBeenCalledTimes(1);
      // A different project's array key also wakes the listener; the
      // subscriber re-reads with its own projectId.
      window.dispatchEvent(
        new StorageEvent("storage", { key: ARRAY_KEY_P2, newValue: "[]" }),
      );
      expect(cb).toHaveBeenCalledTimes(2);
      unsubscribe();
    });

    it("ignores cross-tab `storage` events on unrelated keys", () => {
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "some-other-key",
          newValue: "x",
        }),
      );
      expect(cb).not.toHaveBeenCalled();
      unsubscribe();
    });

    it("stops firing after unsubscribe", () => {
      saveSelectedHostIds(PROJECT, ["a"]);
      const cb = vi.fn();
      const unsubscribe = subscribeSelectedHostIds(cb);
      unsubscribe();
      replaceLeadHostId(PROJECT, "b");
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
