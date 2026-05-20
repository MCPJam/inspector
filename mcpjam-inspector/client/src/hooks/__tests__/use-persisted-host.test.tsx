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
const PROJECT_B = "p2";
const TOGGLE_KEY_P1 = `mcp-inspector-multi-host-enabled:${PROJECT}`;
const TOGGLE_KEY_P2 = `mcp-inspector-multi-host-enabled:${PROJECT_B}`;

describe("usePersistedHost", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("initializes from localStorage (lead + array + toggle)", () => {
    saveSelectedHostIds(PROJECT, ["a", "b"]);
    savePreviewedHostId(PROJECT, "a");
    localStorage.setItem(TOGGLE_KEY_P1, "true");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
    expect(result.current.multiHostEnabled).toBe(true);
  });

  it("returns stored array unchanged when no lead is set", () => {
    saveSelectedHostIds(PROJECT, ["a", "b"]);

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
  });

  it("setSelectedHostIds updates React state and mirrors localStorage without dispatching", () => {
    savePreviewedHostId(PROJECT, "a");
    saveSelectedHostIds(PROJECT, ["a"]);

    const { result } = renderHook(() => usePersistedHost(PROJECT));

    act(() => {
      result.current.setSelectedHostIds(["a", "b"]);
    });

    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
    expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("a");
  });

  it("propagates external `replaceLeadHostId` writes into the hook on the next event tick", () => {
    saveSelectedHostIds(PROJECT, ["a", "extra"]);
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
    saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds[0]).toBe("a");

    // Directly change the previewed host (no array rotation). The hook
    // must surface "b" at slot 0 and filter it out of secondaries.
    act(() => {
      savePreviewedHostId(PROJECT, "b");
    });

    expect(result.current.selectedHostIds[0]).toBe("b");
    // "b" is rotated to slot 0; count (3) preserved.
    expect(result.current.selectedHostIds).toEqual(["b", "a", "c"]);
  });

  // Defensive derivation: external `savePreviewedHostId` writes (from
  // the global host bar or project setup flows) bypass
  // `replaceLeadHostId`. The hook must still preserve column count by
  // REPLACING slot 0 when the new lead isn't in the stored array — not
  // growing the array.
  it("preserves count when an external savePreviewedHostId targets a host NOT in the array", () => {
    saveSelectedHostIds(PROJECT, ["a", "b"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);

    act(() => {
      // Direct lead write (not via replaceLeadHostId): "c" isn't in
      // stored. The hook must replace slot 0, not append.
      savePreviewedHostId(PROJECT, "c");
    });

    expect(result.current.selectedHostIds).toEqual(["c", "b"]);
    expect(result.current.selectedHostIds.length).toBe(2);
  });

  // Defensive derivation, rotate branch: external `savePreviewedHostId`
  // targets a host already in the stored array at index k > 0. The hook
  // must rotate it to slot 0 and preserve count.
  it("preserves count and rotates when an external savePreviewedHostId targets a host already in the array", () => {
    saveSelectedHostIds(PROJECT, ["a", "b", "c"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["a", "b", "c"]);

    act(() => {
      savePreviewedHostId(PROJECT, "c");
    });

    expect(result.current.selectedHostIds).toEqual(["c", "a", "b"]);
    expect(result.current.selectedHostIds.length).toBe(3);
  });

  // Multi-select regression analog from the model hook. Starting from
  // ["a"] with multi-host enabled, the picker calls replaceLeadHostId
  // (re-affirms the existing lead at slot 0 — no array change) then
  // setSelectedHostIds(["a", "b"]). Final state must be ["a", "b"].
  it("adds a second host when picker re-affirms the lead then writes a longer array", () => {
    saveSelectedHostIds(PROJECT, ["a"]);
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
    expect(loadSelectedHostIds(PROJECT)).toEqual(["a", "b"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("a");
  });

  it("preserves column count across a host switch via replaceLeadHostId", () => {
    saveSelectedHostIds(PROJECT, ["host-a", "extra"]);
    savePreviewedHostId(PROJECT, "host-a");

    const { result } = renderHook(() => usePersistedHost(PROJECT));
    expect(result.current.selectedHostIds).toEqual(["host-a", "extra"]);

    act(() => {
      replaceLeadHostId(PROJECT, "host-b");
    });

    expect(result.current.selectedHostIds).toEqual(["host-b", "extra"]);
    expect(loadSelectedHostIds(PROJECT)).toEqual(["host-b", "extra"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("host-b");
  });

  it("setMultiHostEnabled persists to project-scoped localStorage key", () => {
    const { result } = renderHook(() => usePersistedHost(PROJECT));

    act(() => {
      result.current.setMultiHostEnabled(true);
    });
    expect(localStorage.getItem(TOGGLE_KEY_P1)).toBe("true");

    act(() => {
      result.current.setMultiHostEnabled(false);
    });
    expect(localStorage.getItem(TOGGLE_KEY_P1)).toBe("false");
  });

  // Project-scoping: hosts are project entities. The array must NOT
  // leak from project A into project B.
  it("does not surface project A's stored array under project B", () => {
    saveSelectedHostIds(PROJECT, ["a", "b"]);
    savePreviewedHostId(PROJECT, "a");

    const { result } = renderHook(() => usePersistedHost(PROJECT_B));
    expect(result.current.selectedHostIds).toEqual([]);
  });

  it("switching projectId surfaces the new project's persisted array", () => {
    saveSelectedHostIds(PROJECT, ["a", "b"]);
    saveSelectedHostIds(PROJECT_B, ["x", "y", "z"]);
    savePreviewedHostId(PROJECT, "a");
    savePreviewedHostId(PROJECT_B, "x");

    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => usePersistedHost(pid),
      { initialProps: { pid: PROJECT } },
    );
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);

    rerender({ pid: PROJECT_B });
    expect(result.current.selectedHostIds).toEqual(["x", "y", "z"]);

    rerender({ pid: PROJECT });
    expect(result.current.selectedHostIds).toEqual(["a", "b"]);
  });

  // Toggle is per-project too: turning it on for project A must not
  // surface as enabled when project B mounts (and vice versa).
  it("multi-host toggle is per-project (no leakage between projects)", () => {
    localStorage.setItem(TOGGLE_KEY_P1, "true");
    localStorage.setItem(TOGGLE_KEY_P2, "false");

    const { result: resultA } = renderHook(() => usePersistedHost(PROJECT));
    expect(resultA.current.multiHostEnabled).toBe(true);

    const { result: resultB } = renderHook(() => usePersistedHost(PROJECT_B));
    expect(resultB.current.multiHostEnabled).toBe(false);
  });

  it("switching projectId re-reads the toggle from the new project's key", () => {
    localStorage.setItem(TOGGLE_KEY_P1, "true");
    localStorage.setItem(TOGGLE_KEY_P2, "false");

    const { result, rerender } = renderHook(
      ({ pid }: { pid: string }) => usePersistedHost(pid),
      { initialProps: { pid: PROJECT } },
    );
    expect(result.current.multiHostEnabled).toBe(true);

    rerender({ pid: PROJECT_B });
    expect(result.current.multiHostEnabled).toBe(false);
  });
});
