import { describe, expect, it } from "vitest";
import { inheritedGoalTarget } from "../inherited-goal-target";

const goal = (...environmentIds: string[]) => ({ environmentIds });

describe("inheritedGoalTarget", () => {
  it("runs a new goal where this persona's goals already run", () => {
    expect(inheritedGoalTarget([goal("env-a"), goal("env-a")])).toEqual([
      "env-a",
    ]);
  });

  it("takes the most common target, so one stray experiment does not win", () => {
    expect(
      inheritedGoalTarget([goal("env-bad"), goal("env-good"), goal("env-good")])
    ).toEqual(["env-good"]);
  });

  it("keeps a multi-environment fan-out together", () => {
    expect(
      inheritedGoalTarget([goal("env-a", "env-b"), goal("env-a", "env-b")])
    ).toEqual(["env-a", "env-b"]);
  });

  it("treats a different order as the same target", () => {
    expect(
      inheritedGoalTarget([goal("env-a", "env-b"), goal("env-b", "env-a")])
    ).toEqual(["env-a", "env-b"]);
  });

  it("breaks a tie toward the most recent, which is listed first", () => {
    expect(inheritedGoalTarget([goal("env-new"), goal("env-old")])).toEqual([
      "env-new",
    ]);
  });

  it("ignores goals with no target of their own", () => {
    expect(
      inheritedGoalTarget([{ environmentIds: null }, goal("env-a")])
    ).toEqual(["env-a"]);
  });

  it("returns null for a persona with no goals yet", () => {
    expect(inheritedGoalTarget([])).toBeNull();
  });

  it("returns null while the goals are still loading", () => {
    expect(inheritedGoalTarget(undefined)).toBeNull();
  });

  it("returns null when no goal names a target", () => {
    expect(inheritedGoalTarget([{ environmentIds: [] }])).toBeNull();
  });
});

describe("inheritedGoalTarget — stale targets", () => {
  const live = (...ids: string[]) => new Set(ids);

  it("ignores a sibling whose environment is gone", () => {
    expect(
      inheritedGoalTarget([goal("env-archived")], live("env-a"))
    ).toBeNull();
  });

  it("prefers a live target over a more common dead one", () => {
    expect(
      inheritedGoalTarget(
        [goal("env-dead"), goal("env-dead"), goal("env-live")],
        live("env-live")
      )
    ).toEqual(["env-live"]);
  });

  it("drops a fan-out when any of its environments is gone", () => {
    // Half a fan-out is a different target than the one the sibling ran.
    expect(
      inheritedGoalTarget([goal("env-a", "env-gone")], live("env-a"))
    ).toBeNull();
  });

  it("accepts everything when the live set is unknown", () => {
    // The environments query can be loading or skipped; blocking then would
    // drop inheritance for a setup that is fine.
    expect(inheritedGoalTarget([goal("env-a")], undefined)).toEqual(["env-a"]);
  });
});
