import { describe, expect, it } from "vitest";
import {
  reconcileRubricEntries,
  serializeRubricForWire,
  type JourneyCriterion,
} from "../journey-rubric";
import type { Predicate } from "@/shared/eval-matching";

/**
 * The reconciler is the whole reason criterion ids survive authoring.
 *
 * The predicate editor is list-shaped and id-blind, so every keystroke hands
 * back a bare `Predicate[]`. If an edit minted a fresh id, a criterion whose
 * threshold was nudged would look brand new — breaking its cross-run trend and
 * orphaning every result already stamped against it.
 */

const search: Predicate = { type: "toolCalledAtLeastOnce", toolName: "search" };
const quick: Predicate = { type: "turnCountUnder", turns: 3 };

function entry(id: string, predicate: Predicate, label?: string): JourneyCriterion {
  return { id, predicate, ...(label !== undefined ? { label } : {}) };
}

describe("reconcileRubricEntries", () => {
  it("keeps ids for untouched rows", () => {
    const prev = [entry("a", search), entry("b", quick)];
    const next = reconcileRubricEntries(prev, [search, quick]);
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
    expect(next[0]).toBe(prev[0]);
  });

  it("KEEPS the id when a row's predicate is EDITED — the point of the whole thing", () => {
    const prev = [entry("a", quick, "Quick resolution")];
    const edited: Predicate = { type: "turnCountUnder", turns: 5 };
    const next = reconcileRubricEntries(prev, [edited]);
    expect(next).toEqual([
      { id: "a", label: "Quick resolution", predicate: edited },
    ]);
  });

  it("mints an id for a genuinely new row and leaves the others alone", () => {
    const prev = [entry("a", search)];
    const added: Predicate = { type: "noToolErrors" };
    const next = reconcileRubricEntries(prev, [search, added]);
    expect(next[0].id).toBe("a");
    expect(next[1].id).not.toBe("a");
    expect(next[1].id.length).toBeGreaterThan(0);
    expect(next[1].predicate).toBe(added);
  });

  it("keeps survivors' ids when a row in the MIDDLE is removed", () => {
    const middle: Predicate = { type: "noToolErrors" };
    const prev = [entry("a", search), entry("b", middle), entry("c", quick)];
    // Deleting shifts indices, so a purely positional match would hand `c`'s
    // predicate the id `b`.
    const next = reconcileRubricEntries(prev, [search, quick]);
    expect(next.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("keeps ids across a REORDER", () => {
    const prev = [entry("a", search), entry("b", quick)];
    const next = reconcileRubricEntries(prev, [quick, search]);
    expect(next.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("gives DUPLICATE predicates distinct ids — two rows, two trends", () => {
    // Same predicate VALUE authored twice. They are different objects, so
    // identity matching keeps them apart.
    const first: Predicate = { type: "toolCalledAtLeastOnce", toolName: "search" };
    const second: Predicate = { type: "toolCalledAtLeastOnce", toolName: "search" };
    const next = reconcileRubricEntries([], [first, second]);
    expect(next).toHaveLength(2);
    expect(next[0].id).not.toBe(next[1].id);
  });

  it("keeps the id when a row is retyped as a DIFFERENT predicate kind", () => {
    // Still the author editing THAT row. Dropping the id here would break
    // exactly the trend continuity the id exists for.
    const prev = [entry("a", quick, "Quick resolution")];
    const next = reconcileRubricEntries(prev, [search]);
    expect(next).toEqual([
      { id: "a", label: "Quick resolution", predicate: search },
    ]);
  });

  it("does NOT match positionally when the length changed", () => {
    // A shorter list means something was removed; positions past the removal
    // point are meaningless, so a survivor must not inherit a dead row's id.
    // Identity already matched the survivor in pass 1, so `c` keeps `c`.
    const middle: Predicate = { type: "noToolErrors" };
    const prev = [entry("a", search), entry("b", middle), entry("c", quick)];
    const next = reconcileRubricEntries(prev, [middle, quick]);
    expect(next.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("keeps the FIRST row when two rows share one predicate reference", () => {
    // A duplicated row can share the object. Keeping the last would hand row 0
    // row 1's id and mint a fresh one for row 1 — silently swapping which
    // stamped results belong to which row.
    const shared: Predicate = { type: "noToolErrors" };
    const prev = [entry("a", shared), entry("b", shared)];
    const next = reconcileRubricEntries(prev, [shared, shared]);
    expect(next[0].id).toBe("a");
    expect(next[1].id).not.toBe("a");
  });

  it("returns [] for an emptied list", () => {
    expect(reconcileRubricEntries([entry("a", search)], [])).toEqual([]);
  });
});

describe("serializeRubricForWire", () => {
  it("drops a blank label rather than sending an empty string", () => {
    // `""` would persist as "named, with nothing", and the UI would render an
    // empty chip instead of falling back to the formatted predicate.
    expect(
      serializeRubricForWire([entry("a", search, "   "), entry("b", quick, "Fast")]),
    ).toEqual([
      { id: "a", predicate: search },
      { id: "b", label: "Fast", predicate: quick },
    ]);
  });

  it("trims a label that survives", () => {
    expect(serializeRubricForWire([entry("a", search, "  Named  ")])).toEqual([
      { id: "a", label: "Named", predicate: search },
    ]);
  });
});
