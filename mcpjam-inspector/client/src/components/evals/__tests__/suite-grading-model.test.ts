/**
 * Which stage each of a suite's graders measures.
 *
 * The thing worth pinning here is TOTALITY. The settings page groups graders
 * by stage, so a predicate kind this map does not place is a grader that
 * silently disappears from the page — and the page then reads as "that stage
 * has no grader" for a suite that is measuring it. A missing kind is therefore
 * not a cosmetic gap, it is a page that lies about what a suite checks.
 *
 * The routing itself is NOT re-asserted here. It lives in
 * `@mcpjam/sdk/contract`, where the analyzer derives its own selection routing
 * from the same table; restating each kind's stage in this file would create a
 * second opinion, and the one that goes stale is the one on the settings page.
 * What is asserted is that every kind lands SOMEWHERE, exactly once, and that
 * the few placements the settings page depends on hold.
 */

import { describe, expect, it } from "vitest";
import {
  PREDICATE_KINDS,
  USER_VALUE_STAGES,
  type UserValueStage,
} from "@mcpjam/sdk/contract";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  groupGradersByStage,
  STAGE_EMPTY_COPY,
  stageEmptyIsGap,
} from "../suite-grading-model";

/** A structurally-valid predicate of each kind, for the totality sweep. */
function samplePredicate(kind: string): Predicate {
  const base = { type: kind } as Record<string, unknown>;
  // Only the fields the label formatter reads; the model never validates.
  if (kind.startsWith("tool") || kind.startsWith("first") || kind.startsWith("widget"))
    base.toolName = "search";
  if (kind === "responseContains") base.needle = "hi";
  if (kind === "responseMatches") base.pattern = "hi";
  if (kind === "tokenBudgetUnder") base.tokens = 100;
  if (kind === "turnCountUnder") base.turns = 3;
  if (kind === "widgetRenderLatencyUnder") base.ms = 500;
  return base as Predicate;
}

describe("groupGradersByStage", () => {
  it("places every predicate kind the schema admits, exactly once", () => {
    const unplaced: string[] = [];
    for (const kind of PREDICATE_KINDS) {
      const model = groupGradersByStage({
        predicates: [samplePredicate(kind)],
      });
      const inStages = USER_VALUE_STAGES.flatMap(
        (stage) => model.byStage[stage],
      ).filter((row) => row.kind === "predicate");
      const inBudgets = model.budgets.filter((row) => row.kind === "predicate");
      const total = inStages.length + inBudgets.length;
      if (total !== 1) unplaced.push(`${kind} landed in ${total} groups`);
    }
    expect(
      unplaced,
      `Predicate kinds the settings page cannot place — a kind that lands nowhere makes its stage read as ungraded:\n  ${unplaced.join(
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  it("gives every stage a list, even an empty one", () => {
    const model = groupGradersByStage({ predicates: [] });
    for (const stage of USER_VALUE_STAGES) {
      expect(Array.isArray(model.byStage[stage]), stage).toBe(true);
    }
  });

  it("files tool selection at selection and arguments at the tool call", () => {
    const model = groupGradersByStage({
      predicates: [samplePredicate("toolCalledAtLeastOnce")],
    });
    const selection = model.byStage.selection.map((row) => row.id);
    expect(selection).toContain("match:toolCallOrder");
    expect(selection).toContain("match:maxExtraToolCalls");
    expect(selection).toContain("predicate:0");
    // The matcher is ONE stored object but two different judgements: order and
    // extras are about which tool the model reached for, arguments about
    // whether the call it made was usable.
    expect(model.byStage.call.map((row) => row.id)).toEqual([
      "match:argumentMatching",
    ]);
    expect(model.byStage.selection.map((row) => row.id)).not.toContain(
      "match:argumentMatching",
    );
  });

  it("lifts the budget kinds out of the stage groups", () => {
    const model = groupGradersByStage({
      predicates: [
        samplePredicate("tokenBudgetUnder"),
        samplePredicate("turnCountUnder"),
        samplePredicate("responseContains"),
      ],
    });
    expect(model.budgets.map((row) => row.label)).toEqual([
      "Token budget under 100",
      "Fewer than 3 user turns",
    ]);
    // The one non-budget check stays where the contract files it, and the two
    // budgets are NOT also listed there — a grader shown twice reads as two
    // graders.
    const userValueIds = model.byStage.userValue
      .filter((row) => row.kind === "predicate")
      .map((row) => row.id);
    expect(userValueIds).toEqual(["predicate:2"]);
  });

  it("reads the judge's role from the config, advisory by default", () => {
    const withoutRole = groupGradersByStage({ predicates: [] });
    const judge = withoutRole.byStage.userValue.find(
      (row) => row.kind === "judge",
    );
    expect(judge?.role).toBe("advisory");

    const gating = groupGradersByStage({
      predicates: [],
      judgeConfig: { goalCompletion: { role: "gating" } },
    });
    expect(
      gating.byStage.userValue.find((row) => row.kind === "judge")?.role,
    ).toBe("gating");

    // Anything that is not the literal "gating" is advisory. The default has
    // to fail CLOSED: a suite whose role field is absent, misspelled, or from
    // a future build must never be shown as gating on a page people read to
    // decide whether the judge can fail their build.
    const odd = groupGradersByStage({
      predicates: [],
      judgeConfig: { goalCompletion: { role: "GATING" as never } },
    });
    expect(
      odd.byStage.userValue.find((row) => row.kind === "judge")?.role,
    ).toBe("advisory");
  });

  it("every predicate and match row is a gate", () => {
    const model = groupGradersByStage({
      predicates: [samplePredicate("responseContains")],
    });
    const nonJudge = USER_VALUE_STAGES.flatMap(
      (stage) => model.byStage[stage],
    ).filter((row) => row.kind !== "judge");
    expect(nonJudge.length).toBeGreaterThan(0);
    // There is no per-predicate role on the backend, so a row rendered as
    // advisory here would be a control with nowhere to go.
    expect(nonJudge.every((row) => row.role === "gating")).toBe(true);
  });

  it("places an unknown predicate kind without throwing", () => {
    const model = groupGradersByStage({
      predicates: [{ type: "somethingNewFromTheBackend" } as never],
    });
    const row = model.byStage.userValue.find(
      (candidate) => candidate.kind === "predicate",
    );
    expect(row?.label).toBe("somethingNewFromTheBackend");
  });

  it("reads the suite's own pins rather than layering defaults over them", () => {
    // `resolveMatchOptions(suite, case, runOverride)` takes three LAYERS, not a
    // value and its defaults. Passing the defaults as the second argument would
    // override the suite's pins with them, so this suite — which pins strict
    // ordering — would report "Any order".
    const model = groupGradersByStage({
      matchOptions: { toolCallOrder: "strict" },
      predicates: [],
    });
    const order = model.byStage.selection.find(
      (row) => row.matchField === "toolCallOrder",
    );
    expect(order?.label).toContain("Strict order");
  });
});

describe("STAGE_EMPTY_COPY", () => {
  it("never borrows the run-state word for a config state", () => {
    // "Not measured" describes a RUN — a stage no trial reached, or one the
    // analyzer could not decide. On a settings page nothing has been observed
    // at all, so the phrase would state an observation nobody made.
    for (const stage of USER_VALUE_STAGES) {
      expect(STAGE_EMPTY_COPY[stage].toLowerCase()).not.toContain(
        "not measured",
      );
    }
  });

  it("distinguishes a runner-measured stage from an ungraded one", () => {
    const runnerMeasured: UserValueStage[] = ["connection", "discovery", "call"];
    for (const stage of runnerMeasured) {
      expect(stageEmptyIsGap(stage), stage).toBe(false);
      expect(STAGE_EMPTY_COPY[stage]).toContain("Measured by the runner");
    }
    for (const stage of ["selection", "response", "userValue"] as const) {
      expect(stageEmptyIsGap(stage), stage).toBe(true);
      expect(STAGE_EMPTY_COPY[stage]).toBe("No grader");
    }
  });
});
