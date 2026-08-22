/**
 * `diffReusedDraft` answers "what would this draft write?" for two callers with
 * opposite motives — Save sends exactly this, and closing the panel asks
 * whether anything is about to be thrown away. They have to agree: a discard
 * warning that disagrees with what a save would have done is worse than none.
 */
import { describe, expect, it } from "vitest";
import {
  diffReusedDraft,
  type ReusedPersona,
} from "../new-swarm-confirm-step";

const ANA: ReusedPersona = {
  _id: "p-1",
  name: "Ana",
  role: "Ops",
  notes: "Closes the books monthly.",
};

const GOALS = [{ journeyId: "j-1", label: "Reconcile payouts" }];

const draftOf = (overrides: Partial<Record<string, unknown>> = {}) => ({
  name: ANA.name,
  role: ANA.role,
  notes: ANA.notes,
  goals: { "j-1": "Reconcile payouts" },
  ...overrides,
});

describe("diffReusedDraft", () => {
  it("is clean with no draft at all", () => {
    const { patch, goalEdits, dirty } = diffReusedDraft(undefined, ANA, GOALS);
    expect(patch).toEqual({});
    expect(goalEdits).toEqual([]);
    expect(dirty).toBe(false);
  });

  it("is clean for a draft that was opened but never typed in", () => {
    // Opening the panel seeds a draft from the stored row, so "a draft exists"
    // is not the same as "something changed" — treating it as such would fire a
    // discard notice for every Escape and send a no-op patch on every Save,
    // bumping `updatedAt` for every other swarm reusing the row.
    expect(diffReusedDraft(draftOf(), ANA, GOALS).dirty).toBe(false);
  });

  it("sends only the fields that moved", () => {
    const { patch, dirty } = diffReusedDraft(
      draftOf({ role: "Finance ops" }),
      ANA,
      GOALS
    );
    expect(patch).toEqual({ role: "Finance ops" });
    expect(dirty).toBe(true);
  });

  it("treats a changed goal as an edit of its own", () => {
    const { patch, goalEdits, dirty } = diffReusedDraft(
      draftOf({ goals: { "j-1": "Reconcile payouts weekly" } }),
      ANA,
      GOALS
    );
    expect(patch).toEqual({});
    expect(goalEdits).toEqual([
      { journeyId: "j-1", goal: "Reconcile payouts weekly" },
    ]);
    expect(dirty).toBe(true);
  });

  it("ignores an emptied goal, which is nothing it could save", () => {
    // The backend throws on an empty goal, so this is never sent — and since it
    // can't be saved, closing the panel loses nothing by dropping it.
    const { goalEdits, dirty } = diffReusedDraft(
      draftOf({ goals: { "j-1": "   " } }),
      ANA,
      GOALS
    );
    expect(goalEdits).toEqual([]);
    expect(dirty).toBe(false);
  });

  it("reads an absent `notes` on the stored row as an empty string", () => {
    const nameless = { ...ANA, notes: undefined } as unknown as ReusedPersona;
    expect(diffReusedDraft(draftOf({ notes: "" }), nameless, GOALS).dirty).toBe(
      false
    );
    expect(
      diffReusedDraft(draftOf({ notes: "New context" }), nameless, GOALS).patch
    ).toEqual({ notes: "New context" });
  });
});
