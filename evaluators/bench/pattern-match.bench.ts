/**
 * Timing for `toolInputMatches` and `toolResultMatches`, OUTSIDE the CI gate.
 *
 *   npm run bench -w @mcpjam/evaluators
 *
 * The correctness of the pathological cases lives in
 * `tests/tool-input-matches.test.ts` and `tests/tool-result-matches.test.ts`,
 * which assert that each one returns a verdict and nothing about how fast.
 * Wall-clock assertions in a shared CI runner are flaky by construction; a
 * number worth watching belongs here, where it is read by a person rather
 * than failed by a machine.
 */
import { bench, describe } from "vitest";
import { evaluatePredicate } from "../src/predicates/evaluate";
import { canonicalJson, canonicalJsonBounded } from "../src/contract/canonical";
import {
  encodeResultSubject,
  MAX_MATCH_SUBJECT_CHARS,
} from "../src/predicates/pattern-match";
import type { IterationTranscript, Predicate } from "../src/predicates/types";

const subject = "a".repeat(MAX_MATCH_SUBJECT_CHARS);
const transcript = {
  toolCalls: [{ toolName: "write", arguments: { text: subject } }],
};

const check = (patterns: string[]): Predicate => ({
  type: "toolInputMatches",
  toolName: "write",
  path: "/text",
  patterns,
});

describe("patterns that backtrack catastrophically in RegExp", () => {
  for (const pattern of ["(a|a)*b", "(a|a)*$", ".*.*.*=", "(a+)+b"]) {
    bench(`${pattern} over ${MAX_MATCH_SUBJECT_CHARS} chars`, () => {
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
    canonicalJsonBounded(oversized, MAX_MATCH_SUBJECT_CHARS);
  });
  bench("canonicalJson writes all of it (baseline)", () => {
    canonicalJson(oversized);
  });
});

describe("tool results", () => {
  // Text and a structured payload that together fill the budget, so every
  // pattern runs over the full 100,000-character subject.
  const half = "a".repeat(MAX_MATCH_SUBJECT_CHARS / 2 - 16);
  const results: IterationTranscript = {
    toolCalls: [{ toolName: "read", arguments: {} }],
    toolResults: [
      {
        toolName: "read",
        text: half,
        structuredContent: { body: half },
        size: {
          bytes: MAX_MATCH_SUBJECT_CHARS,
          basis: "raw_result",
          complete: true,
        },
      },
    ],
    capture: {
      toolResults: "complete",
      toolCallTimings: "absent",
      toolInventory: "absent",
    },
  };
  for (const pattern of ["(a|a)*b", ".*.*.*="]) {
    bench(`${pattern} over a full-budget result`, () => {
      evaluatePredicate(results, {
        type: "toolResultMatches",
        patterns: [pattern],
      });
    });
  }

  const oversized = {
    toolName: "read",
    structuredContent: {
      rows: Array.from({ length: 50_000 }, (_, index) => ({
        id: index,
        text: "row ".repeat(10),
      })),
    },
  };
  bench("encodeResultSubject stops at the budget", () => {
    encodeResultSubject(oversized, undefined);
  });
});
