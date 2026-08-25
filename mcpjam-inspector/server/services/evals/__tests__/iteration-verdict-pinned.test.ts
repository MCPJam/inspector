import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildEvalIterationVerdict } from "../iteration-verdict.js";

// =============================================================================
// `passed` is the SOLE authority, in every grading mode. B3a adds a score
// projection and an advisory judge; neither is allowed anywhere near this
// module, so the assertion is structural rather than behavioural:
//
//   1. the module's import list is exactly what it was before B3a — no score
//      contract, no grading mode, no judge, no second pass. A verdict that
//      cannot see the score engine cannot be influenced by it.
//   2. its output is unchanged for the same inputs.
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
const ALLOWED_IMPORTS = ["./types", "@/shared/eval-matching", "@mcpjam/sdk"];

describe("iteration-verdict is sealed against the score engine", () => {
  test("imports nothing beyond the pre-B3a allowlist", () => {
    const source = readFileSync(modulePath, "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1]
    );
    expect(specifiers.length).toBeGreaterThan(0);
    expect([...new Set(specifiers)].sort()).toEqual([...ALLOWED_IMPORTS].sort());
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
