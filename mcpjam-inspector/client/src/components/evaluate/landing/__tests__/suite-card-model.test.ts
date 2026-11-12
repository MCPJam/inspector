import { describe, expect, it } from "vitest";
import {
  activeLaunchRunIds,
  buildSuiteCardHealth,
  latestRunState,
  searchSuiteCards,
  sortSuiteCards,
} from "../suite-card-model";
import {
  makeEntry,
  makeRun,
  makeSuite,
  sampleEntry,
} from "./suite-card-fixtures";

describe("buildSuiteCardHealth", () => {
  it("counts only finished, measured, full runs", () => {
    const suite = makeSuite("s");
    const runs = [
      makeRun("s", 1),
      makeRun("s", 2, { rerunScope: "failed_cases" }),
      makeRun("s", 3, { status: "running" }),
      makeRun("s", 4, { result: "inconclusive" }),
      makeRun("s", 5, { result: "cancelled" }),
      makeRun("s", 6, { result: "timed_out" }),
      makeRun("s", 7, { passed: 0, total: 0 }),
      makeRun("s", 8, { passed: 1, total: 2 }),
    ];
    const health = buildSuiteCardHealth(makeEntry(suite, runs));
    expect(health.counted.map((point) => point.runNumber)).toEqual([1, 8]);
    expect(health.average).toBe(75);
  });

  it("falls back to failed === 0 when a run has no verdict", () => {
    const suite = makeSuite("s");
    const health = buildSuiteCardHealth(
      makeEntry(suite, [
        makeRun("s", 1, { result: undefined, passed: 2, total: 2 }),
        makeRun("s", 2, { result: undefined, passed: 1, total: 2 }),
      ]),
    );
    expect(health.counted.map((point) => point.verdict)).toEqual([
      "passed",
      "failed",
    ]);
  });

  it("averages every counted run and bars the last five, oldest first", () => {
    const health = buildSuiteCardHealth(sampleEntry("Excalidraw quickstart"));
    expect(health.counted).toHaveLength(6);
    expect(Math.round(health.average ?? 0)).toBe(75);
    expect(health.points.map((point) => point.runNumber)).toEqual([
      2, 3, 4, 5, 6,
    ]);
  });

  it("sorts counted runs by createdAt, then runNumber", () => {
    const suite = makeSuite("s");
    const health = buildSuiteCardHealth(
      makeEntry(suite, [
        makeRun("s", 3, { createdAt: 10 }),
        makeRun("s", 1, { createdAt: 20 }),
        makeRun("s", 2, { createdAt: 10 }),
      ]),
    );
    expect(health.counted.map((point) => point.runNumber)).toEqual([2, 3, 1]);
  });

  it.each([
    ["Excalidraw quickstart", { kind: "flaky", passed: 2, of: 5 }],
    ["mcpjam-mcp dogfood (production)", { kind: "up", points: 50, of: 5 }],
    ["Asana onboarding smoke", { kind: "down", points: 67, of: 5 }],
    ["Excalidraw basics (Sonnet)", { kind: "steady", of: 5 }],
  ] as const)("reads %s's trend", (name, trend) => {
    expect(buildSuiteCardHealth(sampleEntry(name)).trend).toEqual(trend);
  });

  it("has no trend with no runs and 'one' with one", () => {
    const suite = makeSuite("s");
    expect(buildSuiteCardHealth(makeEntry(suite, [])).trend).toBeNull();
    expect(buildSuiteCardHealth(makeEntry(suite, [])).average).toBeNull();
    expect(
      buildSuiteCardHealth(makeEntry(suite, [makeRun("s", 1)])).trend,
    ).toEqual({ kind: "one" });
  });
});

describe("sortSuiteCards and searchSuiteCards", () => {
  const row = (name: string, average: number | null, at: number) => {
    const entry = makeEntry(makeSuite(name, { name }), [
      makeRun(name, 1, { completedAt: at }),
    ]);
    return {
      entry,
      health: { ...buildSuiteCardHealth(entry), average },
    };
  };
  const rows = [row("b", 50, 1), row("a", null, 3), row("c", 20, 2)];
  const names = (list: typeof rows) =>
    list.map((item) => item.entry.suite.name);

  it("sorts by last run, name, and pass rate with no average last", () => {
    expect(names(sortSuiteCards(rows, "recent"))).toEqual(["a", "c", "b"]);
    expect(names(sortSuiteCards(rows, "name"))).toEqual(["a", "b", "c"]);
    expect(names(sortSuiteCards(rows, "passRate"))).toEqual(["c", "b", "a"]);
  });

  it("names a blank suite Untitled suite for sort and search", () => {
    const blank = row("", 10, 0);
    expect(names(sortSuiteCards([rows[0], blank], "name"))).toEqual(["b", ""]);
    expect(searchSuiteCards([blank], " untitled ")).toHaveLength(1);
  });

  it("searches the trimmed query case-insensitively", () => {
    expect(names(searchSuiteCards(rows, "  B "))).toEqual(["b"]);
    expect(searchSuiteCards(rows, "zzz")).toEqual([]);
  });
});

describe("latestRunState", () => {
  it("names the latest run's state", () => {
    expect(latestRunState(null)).toEqual({ kind: "none" });
    expect(latestRunState(makeRun("s", 1, { passed: 8, total: 12 }))).toEqual({
      kind: "verdict",
      verdict: "failed",
      rate: 67,
    });
    expect(latestRunState(makeRun("s", 1, { status: "grading" }))).toEqual({
      kind: "other",
      label: "Running",
    });
    expect(latestRunState(makeRun("s", 1, { result: "timed_out" }))).toEqual({
      kind: "other",
      label: "Timed out",
    });
  });
});

describe("activeLaunchRunIds", () => {
  it("is the latest run alone without a group", () => {
    const run = makeRun("s", 1, { status: "running" });
    expect(activeLaunchRunIds(makeEntry(makeSuite("s"), [run]))).toEqual([
      run._id,
    ]);
  });

  it("is every active run of the latest run's launch", () => {
    const old = makeRun("s", 1, { runGroupId: "g", status: "completed" });
    const a = makeRun("s", 2, { runGroupId: "g", status: "running" });
    const b = makeRun("s", 3, { runGroupId: "g", status: "pending" });
    const other = makeRun("s", 4, { runGroupId: "h", status: "running" });
    const ids = activeLaunchRunIds(
      makeEntry(makeSuite("s"), [old, a, other, b], b),
    );
    expect(ids.sort()).toEqual([a._id, b._id].sort());
  });
});
