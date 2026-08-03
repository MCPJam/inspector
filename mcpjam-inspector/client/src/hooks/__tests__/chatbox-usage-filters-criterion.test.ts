import { describe, expect, it } from "vitest";
import {
  criterionChipValue,
  parseCriterionChipValue,
  primaryBehaviorTag,
  threadMatchesChip,
  threadMatchesFilterState,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

/**
 * The criterion dimension is the one filter key whose identity lives in the
 * chip VALUE, so the grouping rule carries the whole feature: chips on
 * DIFFERENT criteria must AND ("failed A and failed B"), while pass/fail on
 * ONE criterion must OR.
 *
 * These mirror the backend's `criterionFilters.test.ts` case for case — a
 * divergence would make a server-filtered page and a client-filtered list
 * disagree about what the user selected.
 */

let counter = 0;

function thread(criteria?: SharedChatThread["criteria"]): SharedChatThread {
  counter += 1;
  return {
    _id: `t${counter}`,
    sourceType: "swarm",
    messageCount: 3,
    startedAt: 0,
    lastActivityAt: 0,
    ...(criteria ? { criteria } : {}),
  };
}

function graded(results: Array<[string, boolean]>): SharedChatThread {
  return thread({
    status: "completed",
    generation: 1,
    criterionIds: results.map(([id]) => id),
    results: results.map(([criterionId, passed]) => ({ criterionId, passed })),
    gradedAt: 1,
  });
}

function chip(
  criterionId: string,
  verdict: "pass" | "fail" | "ungraded",
): UsageFilterChip {
  return {
    kind: "dimension",
    key: "criterion",
    value: criterionChipValue(criterionId, verdict),
  };
}

const ALL: UsageFilterState = { preset: "all", chips: [] };

describe("parseCriterionChipValue", () => {
  it("round-trips a value built by criterionChipValue", () => {
    expect(parseCriterionChipValue(criterionChipValue("abc", "fail"))).toEqual({
      criterionId: "abc",
      verdict: "fail",
    });
  });

  it("splits at the LAST colon so an id containing one still resolves", () => {
    expect(parseCriterionChipValue("ns:abc:pass")).toEqual({
      criterionId: "ns:abc",
      verdict: "pass",
    });
  });

  it("returns null for a missing separator, an empty id, or an unknown verdict", () => {
    expect(parseCriterionChipValue("abc")).toBeNull();
    expect(parseCriterionChipValue(":pass")).toBeNull();
    expect(parseCriterionChipValue("abc:maybe")).toBeNull();
  });
});

describe("threadMatchesChip — criterion", () => {
  it("matches pass and fail against the completed verdict", () => {
    const t = graded([
      ["a", true],
      ["b", false],
    ]);
    expect(threadMatchesChip(t, chip("a", "pass"))).toBe(true);
    expect(threadMatchesChip(t, chip("a", "fail"))).toBe(false);
    expect(threadMatchesChip(t, chip("b", "fail"))).toBe(true);
  });

  it("treats pending, failed-grading, and absence alike as ungraded", () => {
    const pending = thread({
      status: "pending",
      generation: 1,
      criterionIds: ["a"],
    });
    const failed = thread({
      status: "failed",
      generation: 1,
      criterionIds: ["a"],
    });
    const noRubric = thread();
    for (const t of [pending, failed, noRubric]) {
      expect(threadMatchesChip(t, chip("a", "ungraded"))).toBe(true);
      expect(threadMatchesChip(t, chip("a", "pass"))).toBe(false);
      expect(threadMatchesChip(t, chip("a", "fail"))).toBe(false);
    }
  });

  it("matches NOTHING for an uninterpretable chip rather than widening", () => {
    const bad: UsageFilterChip = {
      kind: "dimension",
      key: "criterion",
      value: "garbage",
    };
    expect(threadMatchesChip(graded([["a", true]]), bad)).toBe(false);
  });
});

describe("threadMatchesFilterState — criterion grouping", () => {
  const failsBoth = graded([
    ["a", false],
    ["b", false],
  ]);
  const failsAOnly = graded([
    ["a", false],
    ["b", true],
  ]);

  it("ANDs across DIFFERENT criteria — 'fail A + fail B' narrows", () => {
    const filter = { ...ALL, chips: [chip("a", "fail"), chip("b", "fail")] };
    expect(threadMatchesFilterState(failsBoth, filter)).toBe(true);
    expect(threadMatchesFilterState(failsAOnly, filter)).toBe(false);
  });

  it("ORs within ONE criterion — 'pass A + fail A' selects everything graded on A", () => {
    const filter = { ...ALL, chips: [chip("a", "pass"), chip("a", "fail")] };
    expect(threadMatchesFilterState(failsBoth, filter)).toBe(true);
    expect(threadMatchesFilterState(graded([["a", true]]), filter)).toBe(true);
    expect(threadMatchesFilterState(graded([["b", true]]), filter)).toBe(false);
  });
});

describe("primaryBehaviorTag", () => {
  it("uses the PRIORITY order, not array order", () => {
    // A session that both looped and retried is a looping session — the
    // backend collapses it that way, and taking `[0]` would make the two
    // sides select different cohorts for the same chip.
    expect(primaryBehaviorTag(["retried", "looping"])).toBe("looping");
    expect(primaryBehaviorTag(["single_call"])).toBe("single_call");
  });

  it("is null for no tags", () => {
    expect(primaryBehaviorTag(undefined)).toBeNull();
    expect(primaryBehaviorTag([])).toBeNull();
  });
});
