import { describe, expect, it } from "vitest";
import {
  CASE_FIELD_ALIASES_V2,
  EVAL_VOCABULARY_CAPABILITY,
  SUITE_SETTINGS_ALIASES_V2,
} from "../eval-vocabulary.js";

/**
 * The advertised vocabulary block and the alias tables the vocabulary-2
 * request schemas are built from. The header's own parse, refusal and `Vary`
 * are pinned in `eval-edit.test.ts` ("eval vocabulary negotiation").
 */
describe("the advertised eval vocabulary", () => {
  it("is the pinned block, and its field map is the alias tables", () => {
    // The contract's literal (docs/evals-vocabulary-consolidation.md,
    // "Capability"). Pinned as a value so a drift in either the tables or the
    // block is a failing test, not a client reading the wrong spellings.
    expect(EVAL_VOCABULARY_CAPABILITY).toEqual({
      version: 2,
      evaluatorKinds: ["assertion", "judge"],
      assertionKinds: expect.arrayContaining(["noToolErrors"]),
      fields: {
        assertions: ["checks", "predicates"],
        defaultAssertions: ["defaultPredicates", "checks"],
        iterations: ["repetitions"],
        legacyIterations: ["runs"],
      },
    });
    expect(EVAL_VOCABULARY_CAPABILITY.fields.assertions).toBe(
      CASE_FIELD_ALIASES_V2.assertions,
    );
    expect(EVAL_VOCABULARY_CAPABILITY.fields.defaultAssertions).toBe(
      SUITE_SETTINGS_ALIASES_V2.defaultAssertions,
    );
  });

  it("never lists `iterations` as a legacy spelling of the floor", () => {
    // Under vocabulary 1 that key IS the floor; under vocabulary 2 it is the
    // exact count. Advertising it here would tell a canonical client that
    // sending `iterations` means "floor", which is the one reading the
    // negotiated vocabulary exists to rule out.
    expect(EVAL_VOCABULARY_CAPABILITY.fields.legacyIterations).not.toContain(
      "iterations",
    );
  });
});
