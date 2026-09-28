import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";

// =============================================================================
// AMENDED IN B3b, DELIBERATELY. Read this before the tests.
//
// B3a pinned "`passed` is the SOLE authority, in every grading mode". B3b is
// the step that makes the versioned score contract authoritative, so that
// claim is now scoped: it holds in every mode BELOW `enforce`, and at
// `enforce` the iteration's result is derived from its gating score rows
// instead (`allGatingScorersPassed`, in the SDK contract).
//
// The replacement pin ships in the SAME diff — see
// `finalize-iteration-enforce.test.ts`, which asserts the derived result over
// a corpus that includes error, skipped and advisory rows. A pin weakened in
// one PR and replaced in another is a pin that was simply deleted, with a
// promise attached.
//
// WHAT DOES NOT CHANGE, and is what this file still pins:
//
//   1. THE IMPORT SEAL. `iteration-verdict.ts` still cannot see the score
//      contract, the grading mode, the judge or the second pass. This is the
//      load-bearing half and it is UNTOUCHED: at `enforce` the score rows are
//      a projection of what this module decided, so a module that could see
//      them would be grading its own output. That is what would make a
//      mismatch between the two impossible to detect — and detecting it is the
//      entire safety mechanism of the cutover.
//   2. THE OUTPUT SNAPSHOT. Same inputs, same verdict, byte for byte. The
//      evaluation itself does not retire in B3b; the parallel verdict
//      ARITHMETIC does. The matcher, the predicates and the gates all still
//      decide, and the rows report what they decided.
//
// If a future change legitimately needs a new import here, that is a decision
// to be made deliberately: update the allowlist AND explain why the verdict
// needs to know about it.
// =============================================================================

const modulePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "iteration-verdict.ts"
);

/** Every module `iteration-verdict.ts` is permitted to import. */
const ALLOWED_IMPORTS = [
  "./types",
  "@/shared/eval-matching",
  "@mcpjam/sdk",
  // ADDED DELIBERATELY (plan step C3), per the note above.
  //
  // `transcript-evidence.ts` reads the iteration's own trace — tool results,
  // per-call span durations, the advertised tool inventory — and shapes them
  // for the predicate transcript. It is an INPUT to the verdict, in the same
  // class as `@/shared/eval-matching`, and the seal is about OUTPUTS: what
  // this module must not see is the score contract, the grading mode, the
  // judge and the second pass, because at `enforce` the rows are a projection
  // of what this module decided and a module that could read them would be
  // grading its own output. An evidence extractor cannot do that, and the
  // assertion below pins that it stays that way.
  "./transcript-evidence",
  // ADDED DELIBERATELY, per the note above, and for a TYPE only.
  //
  // `agent-activity.ts` imports NOTHING — it is a pure function from a handful
  // of facts about the iteration to `active | exempt | no_agent_activity`. It
  // is an INPUT in the same class as `transcript-evidence`: the verdict is
  // handed the assessment, it does not compute one, and it certainly cannot
  // reach the score contract through it.
  //
  // WHY THE VERDICT NEEDS TO KNOW. The guard has to set `passed = false`, not
  // merely emit a row, because under the `shadow` and `off` grading modes the
  // score rows decide nothing and this boolean still does — a guard that only
  // produced a row would let a vacuous pass stand in the modes most runs use.
  "./agent-activity",
];

/** The extractor is held to the same seal, so widening it is not a back door. */
const EVIDENCE_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "transcript-evidence.ts"
);

describe("iteration-verdict is sealed against the score engine", () => {
  test("imports nothing beyond the pre-B3a allowlist", () => {
    const source = readFileSync(modulePath, "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect([...new Set(specifiers)].sort()).toEqual([...ALLOWED_IMPORTS].sort());
  });

  test("the evidence extractor is sealed the same way", () => {
    const source = readFileSync(EVIDENCE_MODULE, "utf8");
    for (const forbidden of [
      "score-rows",
      "grading-mode",
      "judge",
      "@mcpjam/sdk/contract",
    ]) {
      expect(source, `transcript-evidence.ts mentions "${forbidden}"`).not.toContain(
        forbidden
      );
    }
  });

  test("never mentions the score contract, the mode gate, or the judge", () => {
    const source = readFileSync(modulePath, "utf8");
    for (const forbidden of [
      "gradingMode",
      "grading-mode",
      "score-rows",
      "score-definitions",
      "scoresShadow",
      "judgeVerdict",
      "judgeEvidence",
      "judge-second-pass",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe("buildEvalIterationVerdict output is unchanged", () => {
  const input = {
    promptTurns: [{ prompt: "hi", expectedToolCalls: ["list_files"] }],
    toolsCalledByPrompt: [["list_files"]],
    isNegativeTest: false,
    matchOptions: undefined,
    turnCheckResults: [],
    effectivePredicates: undefined,
    transcriptInput: { messages: [], toolCalls: [] },
    trace: undefined,
    toolErrors: [],
    failOnToolError: false,
    scriptedCheckFailures: [],
  } as unknown as Parameters<typeof buildEvalIterationVerdict>[0];

  test("a passing tool-match iteration still passes, byte for byte", () => {
    const first = buildEvalIterationVerdict(input);
    const second = buildEvalIterationVerdict(input);
    expect(first.passed).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).toMatchSnapshot();
  });

  test("a missing expected tool still fails, byte for byte", () => {
    const failing = buildEvalIterationVerdict({
      ...input,
      toolsCalledByPrompt: [[]],
    } as unknown as Parameters<typeof buildEvalIterationVerdict>[0]);
    expect(failing.passed).toBe(false);
    expect(JSON.stringify(failing)).toMatchSnapshot();
  });
});

describe("the agent-activity gate", () => {
  const input = {
    promptTurns: [{ prompt: "hi", expectedToolCalls: ["list_files"] }],
    toolsCalledByPrompt: [["list_files"]],
    isNegativeTest: false,
    matchOptions: undefined,
    turnCheckResults: [],
    effectivePredicates: undefined,
    transcriptInput: { messages: [], toolCalls: [] },
    trace: undefined,
    toolErrors: [],
    failOnToolError: false,
    scriptedCheckFailures: [],
  } as unknown as Parameters<typeof buildEvalIterationVerdict>[0];

  test("existing fixtures are unchanged when agentActivity is omitted", () => {
    // THE COMPATIBILITY PIN. Absent means "do not ask", so every caller and
    // every recorded fixture gets the verdict it always got.
    expect(buildEvalIterationVerdict(input).passed).toBe(true);
  });

  test("a no_agent_activity iteration does NOT pass", () => {
    // Applied at the VERDICT boundary rather than only as a score row: under
    // the `shadow` and `off` grading modes the rows decide nothing and this
    // boolean still does.
    const verdict = buildEvalIterationVerdict({
      ...input,
      agentActivity: {
        status: "no_agent_activity",
        detail: "nothing ran",
      },
    });
    expect(verdict.passed).toBe(false);
    // The MATCHER's own verdict is untouched: the guard is a gate on top of
    // the evaluation, not a rewrite of it.
    expect(verdict.evaluation.passed).toBe(true);
  });

  test("an exempt assessment changes nothing", () => {
    for (const reason of [
      "model_free",
      "negative_test",
      "no_tool_expected",
      "no_tool_surface",
    ] as const) {
      expect(
        buildEvalIterationVerdict({
          ...input,
          agentActivity: { status: "exempt", reason },
        }).passed,
        `exempt:${reason} should not change the verdict`,
      ).toBe(true);
    }
  });

  test("an active assessment changes nothing", () => {
    expect(
      buildEvalIterationVerdict({
        ...input,
        agentActivity: { status: "active" },
      }).passed,
    ).toBe(true);
  });

  test("does not turn a FAILING iteration into anything else", () => {
    // The gate only ever removes a pass. A case that already failed on its
    // matcher keeps failing for its own reason.
    const verdict = buildEvalIterationVerdict({
      ...input,
      toolsCalledByPrompt: [[]],
      agentActivity: { status: "no_agent_activity", detail: "nothing ran" },
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.evaluation.passed).toBe(false);
  });
});
