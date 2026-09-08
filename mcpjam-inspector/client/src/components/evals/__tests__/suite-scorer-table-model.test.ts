/**
 * Totality and role identity for the Scorers table.
 *
 * A kind this map does not place is a grader that disappears from the page.
 * A role that does not round-trip is a control that lies about what a save
 * would write.
 */

import { describe, expect, it } from "vitest";
import {
  PREDICATE_KINDS,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { groupGradersByStage } from "../suite-grading-model";
import {
  LEGACY_PREDICATE_KINDS,
  ROLE_LEGEND,
  authorablePredicateKinds,
  buildScorerTable,
  libraryCategoryOfKind,
  roleOfJudgeSlot,
  roleOfPredicate,
  scorerLibraryCategories,
  withGoalCompletionRole,
  withPredicateRole,
  type ScorerUiRole,
} from "../suite-scorer-table-model";

function samplePredicate(kind: string): Predicate {
  const base = { type: kind } as Record<string, unknown>;
  if (
    kind.startsWith("tool") ||
    kind.startsWith("first") ||
    kind.startsWith("widget")
  ) {
    base.toolName = "search";
  }
  if (kind === "responseContains") base.needle = "hi";
  if (kind === "responseMatches") base.pattern = "hi";
  if (kind === "tokenBudgetUnder") base.tokens = 100;
  if (kind === "turnCountUnder") base.turns = 3;
  if (kind === "widgetRenderLatencyUnder") base.ms = 500;
  if (kind === "toolLatencyUnder") base.ms = 500;
  if (kind === "toolResultSizeUnder") base.maxBytes = 32_000;
  if (kind === "toolResultContains") base.needle = "hi";
  if (kind === "toolResultMatchesSchema") base.schema = { type: "object" };
  return base as Predicate;
}

describe("library categories", () => {
  it("places every PREDICATE_KINDS member in exactly one category", () => {
    const seen = new Map<string, string>();
    for (const category of scorerLibraryCategories()) {
      for (const kind of category.kinds) {
        expect(seen.has(kind), `${kind} listed in ${seen.get(kind)} and ${category.id}`).toBe(
          false,
        );
        seen.set(kind, category.id);
        expect(libraryCategoryOfKind(kind)).toBe(category.id);
      }
    }
    const missing = (PREDICATE_KINDS as readonly string[]).filter(
      (kind) => !seen.has(kind),
    );
    expect(missing, `kinds with no library category: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("shows Response now that kinds file there", () => {
    // The category was empty and therefore omitted until analyzer 11 filed
    // `noToolErrors` and the four payload/latency checks at `response`.
    const ids = scorerLibraryCategories().map((category) => category.id);
    expect(ids).toContain("selection");
    expect(ids).toContain("userValue");
    expect(ids).toContain("budget");
    expect(ids).toContain("response");
  });

  it("omits a category once its kinds are filtered out", () => {
    // The omission rule itself, asserted over a set the caller controls
    // instead of over whatever happens to be unimplemented this week.
    const ids = scorerLibraryCategories(["responseContains"]).map(
      (category) => category.id,
    );
    expect(ids).toEqual(["userValue"]);
  });

  it("offers only the legacy kinds when the backend advertises none", () => {
    // A deployment that predates `scorers.predicateKinds` cannot evaluate the
    // new ones: offering them would author a check that fails closed as
    // "unknown predicate type" on every trial of the run.
    const legacy = authorablePredicateKinds(undefined);
    expect(legacy).toEqual(LEGACY_PREDICATE_KINDS);
    expect(legacy).not.toContain("toolResultSizeUnder");
    // …and only the intersection when it advertises a set.
    expect(
      authorablePredicateKinds(["responseContains", "notAKindThisBuildKnows"]),
    ).toEqual(["responseContains"]);
  });
});

describe("buildScorerTable groups", () => {
  it("places every PREDICATE_KINDS member in exactly one group", () => {
    const unplaced: string[] = [];
    for (const kind of PREDICATE_KINDS) {
      const predicates = [samplePredicate(kind)];
      const { groups } = buildScorerTable({
        model: groupGradersByStage({ predicates }),
        predicates,
      });
      const hits = groups.flatMap((group) =>
        group.rows.filter((row) => row.kind === "predicate"),
      );
      if (hits.length !== 1) {
        unplaced.push(`${kind} landed in ${hits.length} groups`);
      }
    }
    expect(unplaced).toEqual([]);
  });

  it("files both judge slots under user value", () => {
    const { groups } = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
    });
    const userValue = groups.find((group) => group.stage === "userValue");
    expect(userValue?.rows.map((row) => row.judgeSlot)).toEqual([
      "goalCompletion",
      "groundedness",
    ]);
    expect(
      userValue?.rows.find((row) => row.judgeSlot === "groundedness")
        ?.thresholdKind,
    ).toBe("none");
  });

  it("emits a group for every user-value stage", () => {
    const { groups } = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
    });
    expect(groups.map((group) => group.stage)).toEqual([...USER_VALUE_STAGES]);
  });

  it("puts a muted observed row on connection and discovery", () => {
    const { groups } = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
    });
    for (const stage of ["connection", "discovery"] as const) {
      const group = groups.find((entry) => entry.stage === stage);
      expect(group?.rows).toEqual([
        expect.objectContaining({
          kind: "observed",
          muted: true,
          name: "Observed by the runner",
        }),
      ]);
    }
  });
});

describe("roleOfPredicate / withPredicateRole", () => {
  const roles: ScorerUiRole[] = ["gate", "warn", "report"];

  it("round-trips every role", () => {
    const base = samplePredicate("noToolErrors");
    for (const role of roles) {
      expect(roleOfPredicate(withPredicateRole(base, role))).toBe(role);
    }
  });

  it("strips both policy fields for gate", () => {
    const next = withPredicateRole(
      { type: "noToolErrors", role: "advisory", severity: "warn" },
      "gate",
    );
    expect(next).toEqual({ type: "noToolErrors" });
    expect("role" in next).toBe(false);
    expect("severity" in next).toBe(false);
  });

  it("writes advisory + warn for warn", () => {
    expect(withPredicateRole({ type: "noToolErrors" }, "warn")).toEqual({
      type: "noToolErrors",
      role: "advisory",
      severity: "warn",
    });
  });

  it("writes advisory without severity for report", () => {
    const next = withPredicateRole(
      { type: "noToolErrors", role: "advisory", severity: "warn" },
      "report",
    );
    expect(next).toEqual({ type: "noToolErrors", role: "advisory" });
    expect("severity" in next).toBe(false);
  });
});

describe("roleOfJudgeSlot", () => {
  it("reads gating only as the literal gating role", () => {
    expect(roleOfJudgeSlot("goalCompletion", undefined)).toBe("report");
    expect(
      roleOfJudgeSlot("goalCompletion", { goalCompletion: { role: "advisory" } }),
    ).toBe("report");
    expect(
      roleOfJudgeSlot("goalCompletion", { goalCompletion: { role: "gating" } }),
    ).toBe("gate");
  });

  it("never lets groundedness gate", () => {
    expect(
      roleOfJudgeSlot("groundedness", { goalCompletion: { role: "gating" } }),
    ).toBe("report");
  });

  it("reads goal-completion warn severity as warn", () => {
    expect(
      roleOfJudgeSlot("goalCompletion", {
        goalCompletion: { role: "advisory", severity: "warn" },
      }),
    ).toBe("warn");
  });
});

describe("withGoalCompletionRole", () => {
  it("writes advisory + warn and strips severity for report and gate", () => {
    expect(
      withGoalCompletionRole({ role: "gating", threshold: 0.8 }, "warn"),
    ).toEqual({ threshold: 0.8, role: "advisory", severity: "warn" });
    expect(
      withGoalCompletionRole(
        { role: "advisory", severity: "warn", threshold: 0.8 },
        "report",
      ),
    ).toEqual({ threshold: 0.8, role: "advisory" });
    expect(
      withGoalCompletionRole(
        { role: "advisory", severity: "warn", threshold: 0.8 },
        "gate",
      ),
    ).toEqual({ threshold: 0.8, role: "gating" });
  });
});

describe("ROLE_LEGEND", () => {
  it("names the three authored roles", () => {
    expect(Object.keys(ROLE_LEGEND).sort()).toEqual(["gate", "report", "warn"]);
  });
});

describe("cards", () => {
  it("carry a config line, never a rate", () => {
    const predicates = [samplePredicate("toolCalledAtLeastOnce")];
    const { cards } = buildScorerTable({
      model: groupGradersByStage({ predicates }),
      predicates,
    });
    const selection = cards.find((card) => card.stage === "selection");
    expect(selection?.detail?.label).toMatch(/gate/);
    expect(selection?.detail?.label).not.toMatch(/%/);
    expect(selection?.chip.label.toLowerCase()).not.toContain("not measured");
  });
});
