import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePersistedHost } from "../use-persisted-host";
import {
  loadSelectedHostIds,
  replaceLeadHostId,
  saveSelectedHostIds,
} from "@/lib/selected-host-storage";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "@/lib/previewed-client-storage";

const PROJECT = "p1";

describe("usePersistedHost", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("initializes from localStorage (lead + array + toggle)", () => {
    saveSelectedHostIds(["a", "b"]);
    savePreviewedHostId(PROJECT, "a");
    localStorage.setItem("mcp-inspector-multi-host-enabled", "true");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
    expect(result.current.multiHostEnabled).toBe(true);
  });

  it("returns stored array unchanged when no lead is set", () => {
    saveSelectedHostIds(["a", "b"]);

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
  });

  it("setSelectedHostIds updates React state and mirrors localStorage without dispatching", () => {
    savePreviewedHostId(PROJECT, "a");
    saveSelectedHostIds(["a"]);

    const { result } = renderHook(() => usePersistedHost(PROJECT));

    act(() => {
      result.current.setSelectedHostIds(["a", "b"]);
    });

    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
    expect(loadSelectedHostIds()).toEqual(["a", "b"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("a");
  });

  it("propagates external `replaceLeadHostId` writes into the hook on the next event tick", () => {
    saveSelectedHostIds(["a", "extra"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "extra"]);

    act(() => {
      replaceLeadHostId(PROJECT, "z");
    });

    // Lead is "z", column count preserved at 2, "extra" still secondary.
    expect(result.current.selectedHostIds).toEqual(["z", "extra"]);
  });

  it("derives the lead from previewed host: external savePreviewedHostId surfaces as slot 0", () => {
    saveSelectedHostIds(["a", "b", "c"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds[0]).toBe("a");

    // Directly change the previewed host (no array rotation). The hook
    // must surface "b" at slot 0 and filter it out of secondaries.
    act(() => {
      savePreviewedHostId(PROJECT, "b");
    });

    expect(result.current.selectedHostIds[0]).toBe("b");
    // "b" is removed from secondaries (no duplication) and the
    // remaining stored entries follow.
    expect(result.current.selectedHostIds).toEqual(["b", "a", "c"]);
  });

  // Multi-select regression analog from the model hook. Starting from
  // ["a"] with multi-host enabled, the picker calls replaceLeadHostId
  // (re-affirms the existing lead at slot 0 — no array change) then
  // setSelectedHostIds(["a", "b"]). Final state must be ["a", "b"].
  it("adds a second host when picker re-affirms the lead then writes a longer array", () => {
    saveSelectedHostIds(["a"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    act(() => {
      result.current.setMultiHostEnabled(true);
    });
    expect(result.current.selectedHostIds).toEqual(["a"]);

    act(() => {
      // Step 1: re-affirm existing lead (the picker always sends the
      // current lead at slot 0).
      replaceLeadHostId(PROJECT, "a");
      // Step 2: write the new compare array including the new host.
      result.current.setSelectedHostIds(["a", "b"]);
    });

    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
    expect(loadSelectedHostIds()).toEqual(["a", "b"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("a");
  });

  it("preserves column count across a host switch via replaceLeadHostId", () => {
    saveSelectedHostIds(["host-a", "extra"]);
    savePreviewedHostId(PROJECT, "host-a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["host-a", "extra"]);

    act(() => {
      replaceLeadHostId(PROJECT, "host-b");
    });

    expect(result.current.selectedHostIds).toEqual(["host-b", "extra"]);
    expect(loadSelectedHostIds()).toEqual(["host-b", "extra"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("host-b");
  });

  it("setMultiHostEnabled persists to localStorage", () => {
    const { result } = renderHook(() => usePersistedHost(PROJECT));

    act(() => {
      result.current.setMultiHostEnabled(true);
    });
    expect(localStorage.getItem("mcp-inspector-multi-host-enabled")).toBe(
      "true",
    );

    act(() => {
      result.current.setMultiHostEnabled(false);
    });
    expect(localStorage.getItem("mcp-inspector-multi-host-enabled")).toBe(
      "false",
    );
  });
});
