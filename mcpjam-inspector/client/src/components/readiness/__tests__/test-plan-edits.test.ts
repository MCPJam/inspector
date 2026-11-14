/**
 * The plan edits behind the test plan section: an excluded tool has no
 * cases, an included one gets its cases back in run order with destructive
 * calls last, and an accepted draft lands in its case only.
 */
import { describe, expect, it } from "vitest";
import {
  acceptDraft,
  editBudget,
  editCase,
  editExclusion,
  setToolAction,
} from "../test-plan-edits";
import { DRAFTING, PLAN } from "./test-plan-fixtures";

const ids = (plan: typeof PLAN) => plan.cases.map((entry) => entry.id);

describe("test plan edits", () => {
  it("excluding a tool drops its cases and keeps the rest in order", () => {
    const next = setToolAction(PLAN, "search_docs", "excluded");
    expect(next.tools[0]).toMatchObject({
      tool: "search_docs",
      action: "excluded",
    });
    expect(ids(next)).toEqual(["create_note#valid", "delete_note#valid"]);
  });

  it("including a tool again brings back its saved cases, before the destructive one", () => {
    const excluded = setToolAction(PLAN, "search_docs", "excluded");
    const next = setToolAction(excluded, "search_docs", "run", PLAN);
    expect(ids(next)).toEqual(ids(PLAN));
    expect(next.tools[0]).not.toHaveProperty("exclusion");
  });

  it("including a tool with no saved cases adds one valid-input case to fill in", () => {
    const next = setToolAction(PLAN, "list_projects", "run");
    const added = next.cases.find((entry) => entry.tool === "list_projects");
    expect(added).toEqual({
      id: "list_projects#valid",
      tool: "list_projects",
      kind: "valid",
    });
    expect(next.tools[1]).toEqual({
      tool: "list_projects",
      effect: "read",
      openWorld: true,
      action: "run",
      writes: [],
    });
    expect(ids(next).at(-1)).toBe("delete_note#valid");
  });

  it("limiting a tool to negative cases keeps its cases", () => {
    const next = setToolAction(PLAN, "search_docs", "negative-only");
    expect(ids(next)).toEqual(ids(PLAN));
    expect(next.tools[0].action).toBe("negative-only");
  });

  it("accepts a draft's arguments and expected refusal into its case only", () => {
    const next = acceptDraft(PLAN, DRAFTING.drafts[1]);
    expect(next.cases[2]).toMatchObject({
      arguments: { query: 42 },
      expectedError: "invalid-arguments",
    });
    expect(
      next.cases.filter((entry, index) => entry !== PLAN.cases[index]),
    ).toHaveLength(1);
  });

  it("edits a case, an exclusion and the budget without touching the rest", () => {
    expect(
      editCase(PLAN, "create_note#valid", { arguments: undefined }).cases[0]
        .arguments,
    ).toBeUndefined();
    const reason = editExclusion(PLAN, "list_projects", {
      reason: "other",
      note: "Sample reason",
    });
    expect(reason.tools[1].exclusion).toEqual({
      reason: "other",
      note: "Sample reason",
    });
    expect(editBudget(PLAN, { concurrency: 2 }).budget).toEqual({
      ...PLAN.budget,
      concurrency: 2,
    });
  });
});
