import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadServerOrder, serverCheckQueue } from "@/lib/server-check-queue";
import {
  reconcileServerOrder,
  useServerCardOrder,
} from "../use-server-card-order";

let sequence = 0;
function setup(catalogNames = ["A", "B", "C"], saved?: string[]) {
  const projectId = `card-order-${++sequence}`;
  if (saved)
    localStorage.setItem(
      "mcp-server-order",
      JSON.stringify({ [projectId]: saved }),
    );
  const props = {
    projectId,
    queueProjectId: `${projectId}-shared`,
    catalogNames,
    visibleNames: catalogNames,
    ready: true,
  };
  return { props, ...renderHook(useServerCardOrder, { initialProps: props }) };
}

afterEach(() => vi.restoreAllMocks());

describe("reconcileServerOrder", () => {
  it.each([
    [["A", "B"], undefined, ["A", "B"]],
    [["A", "B"], [], ["A", "B"]],
    [
      ["A", "B", "X", "Y"],
      ["B", "A"],
      ["X", "Y", "B", "A"],
    ],
    [
      ["A", "X"],
      ["B", "A", "A", "gone"],
      ["X", "A"],
    ],
    [
      ["A,B", "C"],
      ["C", "A,B"],
      ["C", "A,B"],
    ],
    [[], ["A"], []],
  ])("reconciles %j against %j", (names, previous, expected) => {
    expect(reconcileServerOrder(names, previous)).toEqual(expected);
  });
});

describe("useServerCardOrder", () => {
  it.each([true, false])(
    "holds a rename slot through old/both/neither/new catalogs and settles saved=%s",
    (success) => {
      const { props, result, rerender } = setup(
        ["A", "B", "C"],
        ["C", "B", "A"],
      );
      let finish = (_saved: boolean) => {};
      act(() => {
        finish = result.current.beginRename("B", "Renamed");
      });
      for (const names of [
        ["A", "B", "C"],
        ["A", "B", "C", "Renamed"],
        ["A", "C"],
        ["A", "C", "Renamed"],
      ]) {
        rerender({ ...props, catalogNames: names, visibleNames: names });
        expect(loadServerOrder(props.projectId)).toEqual(["C", "B", "A"]);
        expect(result.current.orderedServerNames).toEqual(
          names.includes("B")
            ? ["C", "B", "A"]
            : names.includes("Renamed")
              ? ["C", "Renamed", "A"]
              : ["C", "A"],
        );
      }
      expect(serverCheckQueue.getOrder(props.queueProjectId)).toEqual([
        "C",
        "Renamed",
        "A",
      ]);
      act(() => finish(success));
      if (!success) rerender(props);
      const expected = ["C", success ? "Renamed" : "B", "A"];
      expect(loadServerOrder(props.projectId)).toEqual(expected);
      expect(result.current.orderedServerNames).toEqual(expected);
      expect(
        JSON.parse(localStorage.getItem("mcp-server-order")!)[props.projectId],
      ).toEqual(expected);
    },
  );

  it("commits a rename to its origin after a project switch and route remount", () => {
    const { props, result, rerender, unmount } = setup(
      ["A", "B", "C"],
      ["C", "B", "A"],
    );
    let finish = (_saved: boolean) => {};
    act(() => {
      finish = result.current.beginRename("B", "Renamed");
    });
    const other = {
      ...props,
      projectId: `${props.projectId}-other`,
      queueProjectId: `${props.projectId}-other`,
    };
    rerender(other);
    unmount();
    act(() => finish(true));
    expect(loadServerOrder(other.projectId)).toEqual(["A", "B", "C"]);
    expect(loadServerOrder(props.projectId)).toEqual(["C", "Renamed", "A"]);
    const mounted = renderHook(useServerCardOrder, { initialProps: props });
    expect(loadServerOrder(props.projectId)).toEqual(["C", "Renamed", "A"]);
    const names = ["A", "C", "Renamed"];
    mounted.rerender({ ...props, catalogNames: names, visibleNames: names });
    expect(mounted.result.current.orderedServerNames).toEqual([
      "C",
      "Renamed",
      "A",
    ]);
  });

  it("keeps only successful new imports together in final catalog order across out-of-order saves", () => {
    const { props, result, rerender } = setup(["A", "B", "C"], ["C", "A", "B"]);
    let finish = (_name: string, _saved: boolean) => {};
    act(() => {
      finish = result.current.beginImport(["X", "Y", "C", "Failed"]);
    });
    act(() => {
      finish("Y", true);
      finish("Failed", false);
    });
    const partial = [...props.catalogNames, "Y"];
    rerender({ ...props, catalogNames: partial, visibleNames: partial });
    expect(result.current.orderedServerNames).toEqual(["Y", "C", "A", "B"]);
    act(() => {
      finish("X", true);
      finish("C", true);
    });
    expect(result.current.orderedServerNames).toEqual(["Y", "C", "A", "B"]);
    const names = [...props.catalogNames, "X", "Y"];
    rerender({ ...props, catalogNames: names, visibleNames: names });
    expect(result.current.orderedServerNames).toEqual([
      "X",
      "Y",
      "C",
      "A",
      "B",
    ]);
    expect(loadServerOrder(props.projectId)).toEqual(["X", "Y", "C", "A", "B"]);
    act(() => result.current.setOrderedServerNames(["C", "Y", "A", "X", "B"]));
    expect(result.current.orderedServerNames).toEqual([
      "C",
      "Y",
      "A",
      "X",
      "B",
    ]);
  });

  it("keeps import intent scoped across project switches and never reserves failed slots", () => {
    const { props, result, rerender } = setup(["A", "B"], ["B", "A"]);
    let finish = (_name: string, _saved: boolean) => {};
    act(() => {
      finish = result.current.beginImport(["X", "Y", "Failed"]);
    });
    rerender({
      ...props,
      projectId: `${props.projectId}-other`,
      queueProjectId: `${props.projectId}-other`,
    });
    act(() => {
      finish("X", true);
      finish("Y", true);
      finish("Failed", false);
    });
    expect(result.current.orderedServerNames).toEqual(["A", "B"]);
    const partial = [...props.catalogNames, "Y"];
    rerender({
      ...props,
      catalogNames: partial,
      visibleNames: [...partial, "Failed"],
    });
    expect(result.current.orderedServerNames).toEqual(["Y", "B", "A"]);
    const names = [...props.catalogNames, "X", "Y"];
    rerender({ ...props, catalogNames: names, visibleNames: names });
    expect(result.current.orderedServerNames).toEqual(["X", "Y", "B", "A"]);
  });

  it("persists the first complete baseline, then prepends successive adds without losing manual order", () => {
    const { props, result, rerender } = setup();
    expect(loadServerOrder(props.projectId)).toEqual(["A", "B", "C"]);
    act(() => result.current.setOrderedServerNames(["C", "A", "B"]));
    const names = [...props.catalogNames, "Solvapay"];
    rerender({ ...props, catalogNames: names, visibleNames: names });
    expect(result.current.orderedServerNames).toEqual([
      "Solvapay",
      "C",
      "A",
      "B",
    ]);
    const next = [...names, "Calendar"];
    rerender({ ...props, catalogNames: next, visibleNames: next });
    expect(result.current.orderedServerNames).toEqual([
      "Calendar",
      "Solvapay",
      "C",
      "A",
      "B",
    ]);
    expect(
      JSON.parse(localStorage.getItem("mcp-server-order")!)[props.projectId],
    ).toEqual(result.current.catalogOrder);
    expect(serverCheckQueue.getOrder(props.projectId)).toEqual(
      result.current.catalogOrder,
    );
    expect(serverCheckQueue.getOrder(props.queueProjectId)).toEqual(
      result.current.catalogOrder,
    );
  });

  it("does not prune or persist an unresolved catalog, but accepts ready-empty and later additions", () => {
    const { props, result, rerender } = setup(["A", "B"], ["B", "A"]);
    rerender({ ...props, catalogNames: [], visibleNames: [], ready: false });
    expect(loadServerOrder(props.projectId)).toEqual(["B", "A"]);
    expect(result.current.catalogOrder).toBeUndefined();
    rerender({ ...props, catalogNames: [], visibleNames: [], ready: true });
    expect(loadServerOrder(props.projectId)).toEqual([]);
    const names = ["Z", "Y"];
    rerender({ ...props, catalogNames: names, visibleNames: names });
    expect(result.current.orderedServerNames).toEqual(names);
  });

  it("isolates A to B to A, including overlapping names and unresolved switches", () => {
    const { props, result, rerender } = setup(["A", "B"], ["B", "A"]);
    const other = {
      ...props,
      projectId: `${props.projectId}-other`,
      queueProjectId: `${props.projectId}-other`,
      catalogNames: ["A", "Z"],
      visibleNames: ["A", "Z"],
    };
    rerender({ ...other, catalogNames: [], visibleNames: [], ready: false });
    expect(loadServerOrder(other.projectId)).toBeUndefined();
    rerender(other);
    expect(result.current.orderedServerNames).toEqual(["A", "Z"]);
    rerender(props);
    expect(result.current.orderedServerNames).toEqual(["B", "A"]);
  });

  it("keeps runtime-only names visible without making them project preference members", () => {
    const { props, result, rerender } = setup(["A", "B"], ["B", "A"]);
    rerender({ ...props, visibleNames: ["A", "transient", "B"] });
    expect(result.current.orderedServerNames).toEqual(["B", "A", "transient"]);
    act(() => result.current.setOrderedServerNames(["transient", "A", "B"]));
    expect(loadServerOrder(props.projectId)).toEqual(["A", "B"]);
  });

  it("keeps newer session order when writes fail and stale storage remains readable, even after remount", () => {
    const { props, result, unmount } = setup(["A", "B"], ["B", "A"]);
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    act(() => result.current.setOrderedServerNames(["A", "B"]));
    unmount();
    const next = renderHook(useServerCardOrder, { initialProps: props });
    expect(next.result.current.orderedServerNames).toEqual(["A", "B"]);
    expect(
      JSON.parse(localStorage.getItem("mcp-server-order")!)[props.projectId],
    ).toEqual(["B", "A"]);
  });

  it("keeps per-project order through blocked reads/writes and route remounts", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { props, result, unmount, rerender } = setup();
    act(() => result.current.setOrderedServerNames(["C", "B", "A"]));
    const other = {
      ...props,
      projectId: `${props.projectId}-other`,
      catalogNames: ["C", "A"],
      visibleNames: ["C", "A"],
    };
    rerender(other);
    expect(result.current.orderedServerNames).toEqual(["C", "A"]);
    rerender(props);
    expect(result.current.orderedServerNames).toEqual(["C", "B", "A"]);
    unmount();
    expect(
      renderHook(useServerCardOrder, { initialProps: props }).result.current
        .orderedServerNames,
    ).toEqual(["C", "B", "A"]);
  });

  it("recovers malformed or mixed saved arrays and deduplicates the stored baseline", () => {
    const projectId = `malformed-${++sequence}`;
    localStorage.setItem(
      "mcp-server-order",
      JSON.stringify({ [projectId]: ["B", 12, "B", "deleted", "A"] }),
    );
    const props = {
      projectId,
      queueProjectId: projectId,
      catalogNames: ["A", "B", "new"],
      visibleNames: ["A", "B", "new"],
      ready: true,
    };
    expect(
      renderHook(useServerCardOrder, { initialProps: props }).result.current
        .orderedServerNames,
    ).toEqual(["new", "B", "A"]);
    expect(loadServerOrder(projectId)).toEqual(["new", "B", "A"]);
    localStorage.setItem("mcp-server-order", "not json");
    const fallback = { ...props, projectId: `${projectId}-unreadable` };
    expect(
      renderHook(useServerCardOrder, { initialProps: fallback }).result.current
        .orderedServerNames,
    ).toEqual(props.catalogNames);
    expect(
      JSON.parse(localStorage.getItem("mcp-server-order")!)[fallback.projectId],
    ).toEqual(props.catalogNames);
  });
});
