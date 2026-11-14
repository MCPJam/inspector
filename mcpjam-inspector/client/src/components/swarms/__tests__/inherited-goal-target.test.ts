import { describe, expect, it } from "vitest";
import { inheritedGoalTarget } from "../inherited-goal-target";

const goal = (...environmentIds: string[]) => ({ environmentIds });
const legacy = (hostIds: string[], serverAttachmentId?: string) => ({
  hostIds,
  serverAttachmentId,
});

describe("inheritedGoalTarget", () => {
  it("keeps the most common environment fan-out in its original order", () => {
    expect(
      inheritedGoalTarget([goal("stray"), goal("a", "b"), goal("b", "a")]),
    ).toEqual({ hostIds: [], environmentIds: ["a", "b"] });
  });
  it("keeps the first setup when counts tie", () => {
    expect(inheritedGoalTarget([goal("recent"), goal("old")])).toEqual({
      hostIds: [],
      environmentIds: ["recent"],
    });
  });
  it("preserves legacy clients and their selected group", () => {
    expect(
      inheritedGoalTarget([
        legacy(["a", "b"], "selected"),
        legacy(["b", "a"], "selected"),
        goal("other"),
      ]),
    ).toEqual({
      hostIds: ["a", "b"],
      environmentIds: [],
      serverAttachmentId: "selected",
    });
  });
  it("counts groups separately for the same legacy clients", () => {
    expect(
      inheritedGoalTarget([
        legacy(["a"], "stray"),
        legacy(["a"], "selected"),
        legacy(["a"], "selected"),
      ]),
    ).toEqual({
      hostIds: ["a"],
      environmentIds: [],
      serverAttachmentId: "selected",
    });
  });
  it("prefers environments over inactive legacy fields", () => {
    expect(
      inheritedGoalTarget([
        { ...legacy(["client"], "group"), ...goal("environment") },
      ]),
    ).toEqual({ hostIds: [], environmentIds: ["environment"] });
  });
  it.each([goal("missing"), legacy(["client"]), { environmentIds: [] }])(
    "keeps invalid saved setups for validation instead of defaulting",
    (target) => {
      expect(inheritedGoalTarget([target])).not.toBeNull();
    },
  );
  it.each([undefined, []])(
    "returns null only when there are no saved goals",
    (goals) => {
      expect(inheritedGoalTarget(goals)).toBeNull();
    },
  );
});
