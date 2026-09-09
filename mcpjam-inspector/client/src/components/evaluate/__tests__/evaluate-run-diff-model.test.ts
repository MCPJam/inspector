/**
 * The change column, and the adjective it must never add.
 *
 * The diff's own status is the only verb on a row. Everything here checks that
 * this file computes no significance of its own, and that a comparison which
 * did not happen produces no pill rather than "Unchanged" — the difference
 * between "we compared and nothing moved" and "we did not compare".
 */
import { describe, expect, it } from "vitest";
import type { EvalRunCompareDto } from "@/lib/apis/eval-run-compare-api";

import { PASS_WORDS } from "./pass-words";
import {
  derivePillForCase,
  describeRunChanges,
  pillsByRowKey,
  summarizeRunChanges,
} from "../evaluate-run-diff-model";
import type { EvaluateCaseRow } from "../evaluate-case-row-model";

function dto(
  cases: Array<{
    caseKey: string;
    status: string;
    configChanged?: boolean;
  }>,
): EvalRunCompareDto {
  return {
    baseline: { baseRunId: "run_0" },
    baseRun: { id: "run_0", runNumber: 4 },
    compareRun: { id: "run_1", runNumber: 5 },
    cases: cases.map((entry) => ({
      caseKey: entry.caseKey,
      title: entry.caseKey,
      status: entry.status,
      configChanged: entry.configChanged ?? false,
      evaluationConfigChanged: false,
      base: { outcome: "failed", iterationIds: [] },
      compare: { outcome: "failed", iterationIds: [] },
    })),
  } as unknown as EvalRunCompareDto;
}

describe("summarizing a run's changes", () => {
  it("counts each status into its own bucket", () => {
    const summary = summarizeRunChanges(
      dto([
        { caseKey: "a", status: "regressed" },
        { caseKey: "b", status: "fixed" },
        { caseKey: "c", status: "unchanged_failed" },
        { caseKey: "d", status: "unchanged_passed" },
        { caseKey: "e", status: "new_case" },
        { caseKey: "f", status: "removed_case" },
        { caseKey: "g", status: "changed" },
      ]),
    );
    expect(summary).toMatchObject({
      regressed: 1,
      fixed: 1,
      stillFailing: 1,
      passing: 1,
      added: 1,
      removed: 1,
      changed: 1,
      baseRunNumber: 4,
    });
  });

  it("lists only what actually happened", () => {
    // A line reading "0 regressed · 0 fixed" is noise that makes the two
    // numbers that did move harder to find.
    expect(
      describeRunChanges(
        summarizeRunChanges(
          dto([
            { caseKey: "a", status: "regressed" },
            { caseKey: "b", status: "unchanged_passed" },
          ]),
        ),
      ),
    ).toEqual(["1 regressed", "1 passing"]);
  });
});

describe("a row's pill", () => {
  const base = {
    thisRun: { passed: 6, total: 10 },
    previousRun: { passed: 7, total: 10 },
    configChanged: false,
  };

  it("takes its word from the diff and adds no other", () => {
    for (const [status, label] of [
      ["regressed", "Regressed"],
      ["fixed", "Fixed"],
      ["unchanged_failed", "Still failing"],
      ["unchanged_passed", "Unchanged"],
      ["new_case", "New"],
      ["changed", "Reconfigured"],
    ] as const) {
      const pill = derivePillForCase({ ...base, status });
      expect(pill?.label, status).toBe(label);
    }
  });

  it("shows both fractions with no verb between them", () => {
    // A pass-rate move at ten iterations is mostly noise, and a UI that called
    // every move worse or better would make this column worthless.
    const pill = derivePillForCase({ ...base, status: "regressed" });
    expect(pill?.detail).toBe("6/10, was 7/10");
    expect(pill?.detail).not.toMatch(/\b(worse|better|down|up|improved)\b/i);
  });

  it("says single iteration rather than 1/1, was 1/1", () => {
    const pill = derivePillForCase({
      status: "unchanged_failed",
      thisRun: { passed: 0, total: 1 },
      previousRun: { passed: 0, total: 1 },
      configChanged: false,
    });
    expect(pill?.detail).toBe("single iteration");
  });

  it("withholds fractions across a config change", () => {
    // Two different tests are not a trend.
    const pill = derivePillForCase({
      ...base,
      status: "changed",
      configChanged: true,
    });
    expect(pill?.detail).toBe("config differs from the previous run");
    expect(pill?.detail).not.toMatch(/\d\/\d/);
  });

  it("has no pill for a case that is not on this page", () => {
    expect(derivePillForCase({ ...base, status: "removed_case" })).toBeNull();
  });

  it("INVARIANT: no pill claims a pass the diff did not state", () => {
    for (const status of [
      "regressed",
      "unchanged_failed",
      "changed",
    ] as const) {
      const pill = derivePillForCase({ ...base, status });
      expect(`${pill?.label} ${pill?.detail ?? ""}`, status).not.toMatch(
        PASS_WORDS,
      );
    }
  });
});

describe("attaching pills to rows", () => {
  const rows = [
    { key: "g1", iterations: { passed: 6, total: 10 } },
    { key: "g2", iterations: { passed: 1, total: 1 } },
  ] as EvaluateCaseRow[];

  it("joins on the case key the diff groups by", () => {
    const pills = pillsByRowKey({
      rows,
      dto: dto([{ caseKey: "k1", status: "regressed" }]),
      caseKeyOf: (row) => (row.key === "g1" ? "k1" : "k2"),
      previousIterationsOf: () => ({ passed: 7, total: 10 }),
    });
    expect(pills.get("g1")?.kind).toBe("regressed");
    // g2 is not in the comparison, so the comparison says nothing about it.
    expect(pills.has("g2")).toBe(false);
  });

  it("attaches nothing at all without a comparison", () => {
    // Never "Unchanged": that is a claim about a comparison, and no comparison
    // happened.
    const pills = pillsByRowKey({
      rows,
      dto: null,
      caseKeyOf: () => "k1",
      previousIterationsOf: () => null,
    });
    expect(pills.size).toBe(0);
  });
});
