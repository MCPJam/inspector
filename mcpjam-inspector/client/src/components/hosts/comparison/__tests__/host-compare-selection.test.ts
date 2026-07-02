import { describe, expect, it, beforeEach } from "vitest";
import {
  DEFAULT_COMPARE_HOST_IDS,
  parseHostsParam,
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

  it("resolveInitialHostCompareSelection falls back to all live hosts when the default presets aren't known", () => {
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

  it("parseHostsParam splits, trims, and ignores empty entries", () => {
    expect(parseHostsParam("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseHostsParam(" a , ,b ")).toEqual(["a", "b"]);
    expect(parseHostsParam("")).toBeNull();
    expect(parseHostsParam(null)).toBeNull();
    expect(parseHostsParam(undefined)).toBeNull();
  });

  it("resolveInitialHostCompareSelection prefers urlSelection over storage", () => {
    writeHostCompareSelection("proj_1", ["b"]);
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b", "c"],
        previousSelection: [],
        urlSelection: ["c", "a"],
      }),
    ).toEqual(["c", "a"]);
  });

  it("resolveInitialHostCompareSelection falls through when urlSelection has no live hosts", () => {
    writeHostCompareSelection("proj_1", ["b"]);
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b", "c"],
        previousSelection: [],
        urlSelection: ["dead-host"],
      }),
    ).toEqual(["b"]);
  });

  it("resolveInitialHostCompareSelection keeps a preset id from the URL via knownHostIds", () => {
    // A preset is not a live host, so it must be reconciled against the
    // known superset — otherwise a shared/reloaded preset column vanishes.
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a"],
        knownHostIds: ["a", "preset:claude"],
        previousSelection: [],
        urlSelection: ["a", "preset:claude"],
      }),
    ).toEqual(["a", "preset:claude"]);
  });

  it("resolveInitialHostCompareSelection resolves a preset selection with zero live hosts", () => {
    writeHostCompareSelection("proj_1", ["preset:chatgpt"]);
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: [],
        knownHostIds: ["preset:chatgpt", "preset:claude"],
        previousSelection: [],
      }),
    ).toEqual(["preset:chatgpt"]);
  });

  it("resolveInitialHostCompareSelection ignores unrelated presets and falls back to live hosts", () => {
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b"],
        knownHostIds: ["a", "b", "preset:claude", "preset:chatgpt"],
        previousSelection: [],
      }),
    ).toEqual(["a", "b"]);
  });

  it("resolveInitialHostCompareSelection defaults to Codex + Claude Code over live hosts on a fresh visit", () => {
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: ["a", "b"],
        knownHostIds: [
          "a",
          "b",
          ...DEFAULT_COMPARE_HOST_IDS,
          "preset:chatgpt",
        ],
        previousSelection: [],
      }),
    ).toEqual([...DEFAULT_COMPARE_HOST_IDS]);
  });

  it("resolveInitialHostCompareSelection defaults to Codex + Claude Code with zero live hosts", () => {
    expect(
      resolveInitialHostCompareSelection({
        projectId: "proj_1",
        liveHostIds: [],
        knownHostIds: [...DEFAULT_COMPARE_HOST_IDS, "preset:chatgpt"],
        previousSelection: [],
      }),
    ).toEqual([...DEFAULT_COMPARE_HOST_IDS]);
  });
});
