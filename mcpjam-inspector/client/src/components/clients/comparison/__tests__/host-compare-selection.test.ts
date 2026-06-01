import { describe, expect, it, beforeEach } from "vitest";
import {
  reconcileHostCompareSelection,
  resolveInitialHostCompareSelection,
  toggleHostCompareSelection,
  writeHostCompareSelection,
  readHostCompareSelection,
} from "../host-compare-selection";

describe("host-compare-selection", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("toggleHostCompareSelection adds and removes ids while keeping a minimum", () => {
    expect(toggleHostCompareSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleHostCompareSelection(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleHostCompareSelection(["a"], "a")).toEqual(["a"]);
  });

  it("reconcileHostCompareSelection drops deleted hosts", () => {
    expect(
      reconcileHostCompareSelection(["a", "b", "c"], new Set(["a", "c"])),
    ).toEqual(["a", "c"]);
  });

  it("resolveInitialHostCompareSelection prefers stored session selection", () => {
    writeHostCompareSelection("proj_1", ["b", "c"]);
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b", "c"],
        previousSelection: ["a"],
      }),
    ).toEqual(["b", "c"]);
  });

  it("resolveInitialHostCompareSelection falls back to all live hosts", () => {
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b"],
        previousSelection: [],
      }),
    ).toEqual(["a", "b"]);
  });

  it("readHostCompareSelection returns null for invalid storage", () => {
    sessionStorage.setItem("host-compare-selected:proj_1", "{not-json");
    expect(readHostCompareSelection("proj_1")).toBeNull();
  });
});
