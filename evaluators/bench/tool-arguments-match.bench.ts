/**
 * Timing for `toolArgumentsMatch`, OUTSIDE the CI gate.
 *
 *   npm run bench -w @mcpjam/evaluators
 *
 * The correctness of the pathological cases lives in
 * `tests/tool-arguments-match.test.ts`, which asserts that each one returns a
 * verdict and nothing about how fast. Wall-clock assertions in a shared CI
 * runner are flaky by construction; a number worth watching belongs here,
 * where it is read by a person rather than failed by a machine.
 */
import { bench, describe } from "vitest";
import { evaluatePredicate } from "../src/predicates/evaluate";
import { canonicalJson, canonicalJsonBounded } from "../src/contract/canonical";
import { MAX_TOOL_ARGUMENT_SUBJECT_CHARS } from "../src/predicates/tool-arguments-match";
import type { Predicate } from "../src/predicates/types";

const subject = "a".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS);
const transcript = {
  toolCalls: [{ toolName: "write", arguments: { text: subject } }],
};

const check = (patterns: string[]): Predicate => ({
  type: "toolArgumentsMatch",
  toolName: "write",
  argument: "text",
  patterns,
});

describe("patterns that backtrack catastrophically in RegExp", () => {
  for (const pattern of ["(a|a)*b", "(a|a)*$", ".*.*.*=", "(a+)+b"]) {
    bench(`${pattern} over ${MAX_TOOL_ARGUMENT_SUBJECT_CHARS} chars`, () => {
      evaluatePredicate(transcript, check([pattern]));
    });
  }
});

describe("eight patterns over a full-budget subject", () => {
  bench("8 literal patterns", () => {
    evaluatePredicate(
      transcript,
      check(["a", "aa", "aaa", "b", "c", "d", "e", "f"])
    );
  });
});

describe("bounded encoding of an oversized argument", () => {
  const oversized = {
    elements: Array.from({ length: 50_000 }, (_, index) => ({
      id: `n${index}`,
      text: "label ".repeat(10),
    })),
  };
  bench("canonicalJsonBounded stops at the budget", () => {
    canonicalJsonBounded(oversized, MAX_TOOL_ARGUMENT_SUBJECT_CHARS);
  });
  bench("canonicalJson writes all of it (baseline)", () => {
    canonicalJson(oversized);
  });
});
