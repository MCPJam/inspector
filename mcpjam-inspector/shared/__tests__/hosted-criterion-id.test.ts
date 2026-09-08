/**
 * These strings are PERSISTED.
 *
 * Every hosted iteration ever graded stored `predicate:<criterionId>` in its
 * `metadata.evaluationConfig.definitions[].scorerId`, and both the server's
 * score-row builder and the client's scorecard join recompute them. A change
 * to the digest inputs is therefore a change to historical data: rows stop
 * joining and every scorer on a past trial silently reads "not measured".
 *
 * So the ids below are pinned as literals, captured from the implementation as
 * it stood when it lived in `server/services/evals/score-definitions.ts`. If
 * one of them moves, the question is never "update the fixture" — it is
 * whether the move was intended and what it does to every stored run.
 */

import { describe, expect, it } from "vitest";
import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  hostedCriterionId,
  hostedPredicateScorerId,
  HOSTED_JUDGE_SCORER_ID,
  HOSTED_TOOL_MATCH_SCORER_ID,
} from "../hosted-criterion-id";

const toolCalled = {
  type: "toolCalledAtLeastOnce",
  toolName: "get_me",
} as Predicate;
const noToolErrors = { type: "noToolErrors" } as Predicate;
const responseContains = {
  type: "responseContains",
  needle: "marcelo@mcpjam.com",
} as Predicate;

describe("hostedCriterionId", () => {
  it("mints the ids stored on every hosted run to date", () => {
    expect(hostedCriterionId(toolCalled)).toBe(
      "toolCalledAtLeastOnce-820968cbcecd",
    );
    expect(hostedCriterionId(noToolErrors)).toBe("noToolErrors-037586125822");
    expect(hostedCriterionId(responseContains)).toBe(
      "responseContains-7ae990f7e93d",
    );
  });

  it("keeps a check's identity when only its policy changes", () => {
    // A Gate → Warn edit must not renumber score rows or look like a new
    // scorer: `role` and `severity` say what a miss DOES, not what is checked.
    const warned = {
      ...toolCalled,
      role: "advisory",
      severity: "warn",
    } as Predicate;
    const reported = { ...toolCalled, role: "advisory" } as Predicate;
    expect(hostedCriterionId(warned)).toBe(hostedCriterionId(toolCalled));
    expect(hostedCriterionId(reported)).toBe(hostedCriterionId(toolCalled));
  });

  it("treats turn scope as part of what is being asserted", () => {
    // A step-scoped `noToolErrors` sees the transcript up to that step; the
    // whole-run one sees all of it. Same predicate, different claim.
    expect(hostedCriterionId(toolCalled, { kind: "turn", promptIndex: 0 })).toBe(
      "toolCalledAtLeastOnce-0569dcde52ac",
    );
    expect(
      hostedCriterionId(noToolErrors, { kind: "turn", promptIndex: 1 }),
    ).toBe("noToolErrors-b595e8c28592");
    expect(hostedCriterionId(noToolErrors, { kind: "turn", promptIndex: 1 })).not.toBe(
      hostedCriterionId(noToolErrors),
    );
  });

  it("distinguishes one turn from another", () => {
    expect(hostedCriterionId(noToolErrors, { kind: "turn", promptIndex: 0 })).not.toBe(
      hostedCriterionId(noToolErrors, { kind: "turn", promptIndex: 1 }),
    );
  });

  it("prefixes the scorer id the score rows carry", () => {
    expect(hostedPredicateScorerId(toolCalled)).toBe(
      `predicate:${hostedCriterionId(toolCalled)}`,
    );
    expect(hostedPredicateScorerId(noToolErrors, { kind: "turn", promptIndex: 1 })).toBe(
      "predicate:noToolErrors-b595e8c28592",
    );
  });

  it("names the two platform scorers the same way the server does", () => {
    expect(HOSTED_TOOL_MATCH_SCORER_ID).toBe("toolCalls:match");
    expect(HOSTED_JUDGE_SCORER_ID).toBe("judge:goalCompletion");
  });
});
