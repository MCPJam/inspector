/**
 * Totality and role identity for the Scorers table.
 *
 * A kind this map does not place is a grader that disappears from the page.
 * A role that does not round-trip is a control that lies about what a save
 * would write.
 */

import { describe, expect, it } from "vitest";
import {
  authoredRequiredRole,
  PREDICATE_KINDS,
  USER_VALUE_STAGES,
} from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import { groupGradersByStage } from "../suite-grading-model";
import {
  LEGACY_PREDICATE_KINDS,
  RUNNER_MEASUREMENT_LABELS,
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
import {
  STANDARD_ASSERTION_CHECKS,
  listEffectiveRules,
} from "../standard-checks-model";

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
    // Ask about EVERY kind, not only the ones offered by default: this guard
    // is about categorisation being total, and an opt-in kind that no default
    // surface lists still has to land in exactly one category when a surface
    // does ask for it.
    for (const category of scorerLibraryCategories(PREDICATE_KINDS)) {
      for (const kind of category.kinds) {
        expect(
          seen.has(kind),
          `${kind} listed in ${seen.get(kind)} and ${category.id}`,
        ).toBe(false);
        seen.set(kind, category.id);
        expect(libraryCategoryOfKind(kind)).toBe(category.id);
      }
    }
    const missing = (PREDICATE_KINDS as readonly string[]).filter(
      (kind) => !seen.has(kind),
    );
    expect(
      missing,
      `kinds with no library category: ${missing.join(", ")}`,
    ).toEqual([]);
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
    expect(
      userValue?.rows
        .filter((row) => row.kind === "judge")
        .map((row) => row.judgeSlot),
    ).toEqual(["goalCompletion", "groundedness"]);
    expect(
      userValue?.rows.find((row) => row.judgeSlot === "groundedness")
        ?.thresholdKind,
    ).toBe("none");
  });

  it("adds the rubric-checks row after the other judges when graded", () => {
    const table = (
      judgeConfig?: Parameters<typeof buildScorerTable>[0]["judgeConfig"],
    ) =>
      buildScorerTable({
        model: groupGradersByStage({
          predicates: [],
          judgeConfig,
          rubricChecks: true,
        }),
        predicates: [],
        judgeConfig,
      }).groups.find((group) => group.stage === "userValue");
    const userValue = table();
    expect(
      userValue?.rows
        .filter((row) => row.kind === "judge")
        .map((row) => row.judgeSlot),
    ).toEqual(["goalCompletion", "groundedness", "rubricChecks"]);
    const row = userValue?.rows.find((r) => r.judgeSlot === "rubricChecks");
    expect(row).toMatchObject({
      enabled: true,
      role: "advisory",
      thresholdKind: "none",
    });
    expect(
      table({ rubricChecks: { enabled: false } })?.rows.find(
        (r) => r.judgeSlot === "rubricChecks",
      )?.enabled,
    ).toBe(false);
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
      // First, ahead of any standard check the stage lists as off.
      expect(group?.rows[0]).toEqual(
        expect.objectContaining({
          kind: "observed",
          muted: true,
          enabled: true,
          name: RUNNER_MEASUREMENT_LABELS[stage],
        }),
      );
      expect(
        group?.rows.slice(1).every((row) => row.kind === "preset"),
        stage,
      ).toBe(true);
    }
  });

  it("lists every standard check nothing authors as an off preset row, once", () => {
    const { groups } = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
    });
    const presets = groups.flatMap((group) =>
      group.rows.filter((row) => row.kind === "preset"),
    );
    expect(presets.map((row) => row.family?.id).sort()).toEqual(
      STANDARD_ASSERTION_CHECKS.map((check) => check.id).sort(),
    );
    for (const row of presets) {
      expect(row.enabled).toBe(false);
      // The presets still carry `severity: "warn"` on the wire; the tier they
      // read as is Advisory, because severity no longer names one.
      expect(row.role).toBe("advisory");
      const stage = groups.find((group) => group.rows.includes(row))?.stage;
      expect(stage).toBe(
        STANDARD_ASSERTION_CHECKS.find((check) => check.id === row.family?.id)
          ?.stage,
      );
    }
    // Listing can be switched off for a surface that only wants what is on.
    const bare = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
      listPresets: false,
    });
    expect(
      bare.groups.flatMap((group) =>
        group.rows.filter((row) => row.kind === "preset"),
      ),
    ).toEqual([]);
  });

  it("keeps an enabled standard check in its catalog slot", () => {
    const output = STANDARD_ASSERTION_CHECKS.find(
      (check) => check.id === "response.schema",
    )!;
    const discovery = STANDARD_ASSERTION_CHECKS.filter(
      (check) => check.stage === "discovery",
    ).map((check) => check.id);
    const { groups } = buildScorerTable({
      model: groupGradersByStage({ predicates: [output.preset] }),
      predicates: [output.preset],
    });
    const discoveryGroup = groups.find((group) => group.stage === "discovery")!;
    expect(
      discoveryGroup.rows.filter((row) => row.family).map((row) => row.family!.id),
    ).toEqual(discovery);
    expect(
      discoveryGroup.rows.find((row) => row.family?.id === output.id),
    ).toEqual(expect.objectContaining({ kind: "predicate", enabled: true }));
  });

  it("drops the preset row once any rule of its kind is listed, suppressed or not", () => {
    const latency = STANDARD_ASSERTION_CHECKS.find(
      (check) => check.id === "response.performance",
    )!;
    const suite: Predicate[] = [{ type: "toolLatencyUnder", ms: 1234 }];
    const rules = listEffectiveRules(suite, {
      suppressedSuiteStandardCheckIds: [latency.id],
    });
    const { groups, cards } = buildScorerTable({
      model: groupGradersByStage({ predicates: suite }),
      activeModel: groupGradersByStage({ predicates: [] }),
      predicates: suite,
      rules,
    });
    const response = groups.find((group) => group.stage === "response")!;
    const listed = response.rows.filter((row) => row.family?.id === latency.id);
    expect(listed).toEqual([
      expect.objectContaining({
        kind: "predicate",
        source: "suite",
        suppressed: true,
        enabled: false,
        muted: true,
        family: expect.objectContaining({ id: latency.id, suiteRules: 1 }),
      }),
    ]);
    // A suppressed rule is listed, not counted: the card reads as ungraded.
    expect(cards.find((card) => card.stage === "response")?.chip.label).toBe(
      "No evaluator",
    );
  });

  it("reads a case's judge-skipped flag into the judge row and the card", () => {
    const build = (judgeEnabled?: boolean) =>
      buildScorerTable({
        model: groupGradersByStage({ predicates: [] }),
        predicates: [],
        judgeConfig: { goalCompletion: { autoRun: true } },
        judgeEnabled,
      });
    const judgeRow = (view: ReturnType<typeof build>) =>
      view.groups
        .find((group) => group.stage === "userValue")
        ?.rows.find((row) => row.judgeSlot === "goalCompletion");
    const card = (view: ReturnType<typeof build>) =>
      view.cards.find((card) => card.stage === "userValue")?.chip.label;
    expect(judgeRow(build())?.enabled).toBe(true);
    expect(card(build())).toBe("Judge automatic");
    expect(judgeRow(build(false))?.enabled).toBe(false);
    expect(card(build(false))).toBe("Judge off");
    // A case cannot switch on a judge the suite turned off.
    const off = buildScorerTable({
      model: groupGradersByStage({ predicates: [] }),
      predicates: [],
      judgeConfig: { goalCompletion: { enabled: false } },
      judgeEnabled: true,
    });
    expect(judgeRow(off)?.enabled).toBe(false);
  });
});

describe("roleOfPredicate / withPredicateRole", () => {
  const roles: ScorerUiRole[] = ["required", "advisory"];

  it("round-trips every role", () => {
    const base = samplePredicate("noToolErrors");
    for (const role of roles) {
      expect(roleOfPredicate(withPredicateRole(base, role))).toBe(role);
    }
  });

  it("strips both policy fields for required", () => {
    const next = withPredicateRole(
      { type: "noToolErrors", role: "advisory", severity: "warn" },
      "required",
    );
    expect(next).toEqual({ type: "noToolErrors" });
    expect("role" in next).toBe(false);
    expect("severity" in next).toBe(false);
  });

  it("writes advisory with no severity", () => {
    const next = withPredicateRole({ type: "noToolErrors" }, "advisory");
    expect(next).toEqual({ type: "noToolErrors", role: "advisory" });
    expect("severity" in next).toBe(false);
  });

  it("drops a stored severity when the author re-picks advisory", () => {
    const next = withPredicateRole(
      { type: "noToolErrors", role: "advisory", severity: "warn" },
      "advisory",
    );
    expect(next).toEqual({ type: "noToolErrors", role: "advisory" });
    expect("severity" in next).toBe(false);
  });

  // Severity no longer names a tier, so a stored `severity: "warn"` row reads
  // as Advisory exactly like one without it. This is the Warn/Report collapse.
  it("reads a stored warn severity as advisory, not a third tier", () => {
    expect(
      roleOfPredicate({
        type: "noToolErrors",
        role: "advisory",
        severity: "warn",
      }),
    ).toBe("advisory");
    expect(roleOfPredicate({ type: "noToolErrors", role: "advisory" })).toBe(
      "advisory",
    );
  });

  it("fails closed: an absent or unknown role is required", () => {
    expect(roleOfPredicate({ type: "noToolErrors" })).toBe("required");
    expect(
      roleOfPredicate({
        type: "noToolErrors",
        role: "nonsense",
      } as unknown as Predicate),
    ).toBe("required");
  });
});

describe("roleOfJudgeSlot", () => {
  it("reads required only as the literal gating role", () => {
    expect(roleOfJudgeSlot("goalCompletion", undefined)).toBe("advisory");
    expect(
      roleOfJudgeSlot("goalCompletion", {
        goalCompletion: { role: "advisory" },
      }),
    ).toBe("advisory");
    expect(
      roleOfJudgeSlot("goalCompletion", { goalCompletion: { role: "gating" } }),
    ).toBe("required");
  });

  it("never lets groundedness gate", () => {
    expect(
      roleOfJudgeSlot("groundedness", { goalCompletion: { role: "gating" } }),
    ).toBe("advisory");
  });

  it("never lets rubric checks gate", () => {
    expect(
      roleOfJudgeSlot("rubricChecks", { goalCompletion: { role: "gating" } }),
    ).toBe("advisory");
  });

  it("reads a goal-completion warn severity as advisory", () => {
    expect(
      roleOfJudgeSlot("goalCompletion", {
        goalCompletion: { role: "advisory", severity: "warn" },
      }),
    ).toBe("advisory");
  });
});

describe("withGoalCompletionRole", () => {
  // The wire value is whatever THIS BUILD emits: the client and the server it
  // writes to are one deployment, so there is no handshake to wait for — a
  // deployment that shipped this build shipped the boundary with it.
  it("writes the emitted spelling for required and strips severity", () => {
    expect(
      withGoalCompletionRole(
        { role: "advisory", severity: "warn", threshold: 0.8 },
        "required",
      ),
    ).toEqual({ threshold: 0.8, role: authoredRequiredRole() });
    expect(
      withGoalCompletionRole(
        { role: "advisory", severity: "warn", threshold: 0.8 },
        "advisory",
      ),
    ).toEqual({ threshold: 0.8, role: "advisory" });
    expect(
      withGoalCompletionRole({ role: "gating", threshold: 0.8 }, "advisory"),
    ).toEqual({ threshold: 0.8, role: "advisory" });
  });
});

describe("ROLE_LEGEND", () => {
  it("names the two authored tiers", () => {
    expect(Object.keys(ROLE_LEGEND).sort()).toEqual(["advisory", "required"]);
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
    expect(selection?.detail?.label).toMatch(/required/);
    expect(selection?.detail?.label).not.toMatch(/%/);
    expect(selection?.chip.label.toLowerCase()).not.toContain("not measured");
  });
});

it("requires advertised runner support before offering responseCloseTo", () => {
  expect(authorablePredicateKinds(undefined)).not.toContain("responseCloseTo");
  expect(authorablePredicateKinds([])).not.toContain("responseCloseTo");
  expect(authorablePredicateKinds(["responseCloseTo"])).toEqual([
    "responseCloseTo",
  ]);
});

it("uses the catalog name for authored and preset families", () => {
  const predicates = [STANDARD_ASSERTION_CHECKS[0].preset];
  const table = buildScorerTable({
    model: groupGradersByStage({ predicates }),
    predicates,
  });
  for (const row of table.groups.flatMap((group) => group.rows)) {
    if (row.family)
      expect(row.family.name).toBe(
        STANDARD_ASSERTION_CHECKS.find((check) => check.id === row.family!.id)!
          .name,
      );
  }
});
