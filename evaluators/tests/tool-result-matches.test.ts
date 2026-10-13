import {
  assertion,
  evaluatePredicate,
  evaluateTurnChecks,
  isTurnScopablePredicateKind,
  predicateSchema,
  runEvaluatorsProjected,
  TURN_SCOPABLE_PREDICATE_KINDS,
} from "../src/index";
import type {
  IterationTranscript,
  Predicate,
  TranscriptCaptureState,
  TranscriptToolCall,
  TranscriptToolResult,
} from "../src/predicates/types";
import { canonicalDigest } from "../src/contract/canonical";
import { predicateScoreDefinition } from "../src/contract/adapters";
import { stripCheckPolicy } from "../src/predicates/policy";
import {
  encodeResultSubject,
  MAX_MATCH_SUBJECT_CHARS,
  TOOL_INPUT_MATCHES_IMPLEMENTATION,
  TOOL_RESULT_MATCHES_IMPLEMENTATION,
} from "../src/predicates/pattern-match";

type Rule = Extract<Predicate, { type: "toolResultMatches" }>;

const rule = (over: Partial<Rule> = {}): Rule => ({
  type: "toolResultMatches",
  patterns: ["Idea", "Build", "Ship"],
  flags: "i",
  ...over,
});

const result = (
  over: Partial<TranscriptToolResult> = {}
): TranscriptToolResult => ({
  toolName: "create_view",
  size: { bytes: 10, basis: "model_visible_output", complete: true },
  ...over,
});

/**
 * One call per result by default, so the scope reads as "every call returned";
 * `calls` overrides that for the calls-without-results cases.
 */
const transcript = (
  results: TranscriptToolResult[],
  options: {
    calls?: TranscriptToolCall[];
    capture?: TranscriptCaptureState;
  } = {}
): IterationTranscript => ({
  toolCalls:
    options.calls ??
    results.map((r) => ({ toolName: r.toolName, arguments: {} })),
  toolResults: results,
  capture: {
    toolResults: options.capture ?? "complete",
    toolCallTimings: "absent",
    toolInventory: "absent",
  },
});

const diagram = (...labels: string[]) => ({
  elements: labels.map((text, index) => ({ id: `n${index}`, text })),
});

const context = {
  version: 1 as const,
  scenario: { title: "case" },
  trace: { messages: [] },
};

describe("one result, all patterns", () => {
  it("fails when the three labels are split across three results", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ structuredContent: diagram("Idea") }),
        result({ structuredContent: diagram("Build") }),
        result({ structuredContent: diagram("Ship") }),
      ]),
      rule()
    );
    expect(outcome).toMatchObject({ passed: false });
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain(
      "tools returned 3 results, none matched all 3 patterns in their content"
    );
  });

  it("passes when one result carries all three", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ structuredContent: diagram("idea", "BUILD", "Ship") }),
      ]),
      rule()
    );
    expect(outcome).toMatchObject({ passed: true });
    expect(outcome.reason).toContain("1 matched all 3 patterns");
  });

  it("reads text, structuredContent and json as one subject", () => {
    // The labels sit in three different parts of ONE result: still one unit.
    const outcome = evaluatePredicate(
      transcript([
        result({
          text: "Idea",
          structuredContent: { label: "Build" },
          json: { label: "Ship" },
        }),
      ]),
      rule()
    );
    expect(outcome.passed).toBe(true);
  });

  it("matches JSON parts as canonical JSON, whatever the key order", () => {
    const outcome = evaluatePredicate(
      transcript([result({ structuredContent: { b: 2, a: 1 } })]),
      rule({ patterns: ['^\\{"a":1,"b":2\\}$'], flags: undefined })
    );
    expect(outcome.passed).toBe(true);
  });

  it("includes isError results — an error is still what the tool returned", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ isError: true, text: "rate limited: retry after 30s" }),
      ]),
      rule({ patterns: ["rate limited"] })
    );
    expect(outcome.passed).toBe(true);
  });
});

describe("scope", () => {
  const search = result({ toolName: "search", text: "Idea Build Ship" });
  const view = result({ toolName: "create_view", text: "nothing here" });

  it("reads every tool's results without toolName", () => {
    const outcome = evaluatePredicate(transcript([view, search]), rule());
    expect(outcome.passed).toBe(true);
  });

  it("reads only the named tool's results with toolName", () => {
    const outcome = evaluatePredicate(
      transcript([view, search]),
      rule({ toolName: "create_view" })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain(
      '"create_view" returned 1 result, none matched all 3 patterns'
    );
  });

  it("names the tool of each unmatched result when toolName is unset", () => {
    const outcome = evaluatePredicate(
      transcript([result({ toolName: "search", text: "plain" })]),
      rule({ patterns: ["absent"], flags: undefined })
    );
    expect(outcome.reason).toContain('Got: ["search" "plain"]');
  });
});

describe("path", () => {
  it("reads the key inside structuredContent", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({
          text: "Idea Build Ship",
          structuredContent: { elements: "Idea Build Ship", other: 1 },
        }),
      ]),
      rule({ toolName: "create_view", path: "/elements" })
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain('in their "elements" field');
  });

  it("does not read text when a path is set", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({
          text: "Idea Build Ship",
          structuredContent: { elements: "nothing" },
        }),
      ]),
      rule({ path: "/elements" })
    );
    expect(outcome.passed).toBe(false);
  });

  it("falls back to json only when there is no structuredContent", () => {
    expect(
      evaluatePredicate(
        transcript([result({ json: { elements: "Idea Build Ship" } })]),
        rule({ path: "/elements" })
      ).passed
    ).toBe(true);
    // structuredContent wins even when it lacks the key.
    const shadowed = evaluatePredicate(
      transcript([
        result({
          structuredContent: { other: 1 },
          json: { elements: "Idea Build Ship" },
        }),
      ]),
      rule({ path: "/elements" })
    );
    expect(shadowed.passed).toBe(false);
    expect(shadowed.reason).toContain('1 result had no "elements" field');
  });

  it("matches a string value as it is and anything else as canonical JSON", () => {
    expect(
      evaluatePredicate(
        transcript([result({ structuredContent: { title: "Plan" } })]),
        rule({ path: "/title", patterns: ["^Plan$"], flags: undefined })
      ).passed
    ).toBe(true);
    expect(
      evaluatePredicate(
        transcript([result({ structuredContent: diagram("Idea") })]),
        rule({ path: "/elements", patterns: ['"text":"Idea"'] })
      ).passed
    ).toBe(true);
  });

  it("decodes ~1 and ~0 in the key", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ structuredContent: { "a/b~c": "Idea Build Ship" } }),
      ]),
      rule({ path: "/a~1b~0c" })
    );
    expect(outcome.passed).toBe(true);
  });

  it("treats a missing key, a text-only result and an array root as not matching", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ structuredContent: { other: "Idea Build Ship" } }),
        result({ text: '{"elements":"Idea Build Ship"}' }),
        result({ structuredContent: ["Idea Build Ship"] }),
      ]),
      rule({ path: "/elements" })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain('3 results had no "elements" field');
  });

  it("never reads the prototype", () => {
    expect(
      encodeResultSubject(result({ structuredContent: {} }), "constructor")
    ).toEqual({ kind: "missing" });
  });
});

describe("counting — min and max count MATCHING results", () => {
  it("passes one matching result among ten that do not", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({ text: "Idea Build Ship" }),
        ...Array.from({ length: 10 }, () => result({ text: "unrelated" })),
      ]),
      rule()
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain("tools returned 11 results, 1 matched");
  });

  it("min 0 / max 0 passes when results came back but none matched", () => {
    const outcome = evaluatePredicate(
      transcript([result({ text: "Idea" }), result({ text: "Build" })]),
      rule({ min: 0, max: 0 })
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain("expected no matching result");
    expect(outcome.reason).toContain(
      "min/max count matching results, not all results"
    );
  });

  it("min 0 / max 0 fails when one result matches, naming the ceiling", () => {
    const outcome = evaluatePredicate(
      transcript([result({ text: "Idea Build Ship" }), result({ text: "x" })]),
      rule({ toolName: "create_view", min: 0, max: 0 })
    );
    expect(outcome).toMatchObject({ passed: false });
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain(
      '"create_view" returned 2 results, 1 matched all 3 patterns in their content, allowed at most 0'
    );
  });

  it("fails too few matching results with the exact count", () => {
    const outcome = evaluatePredicate(
      transcript([result({ text: "Idea Build Ship" }), result({ text: "x" })]),
      rule({ min: 2 })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain("expected at least 2 matching result(s)");
  });
});

describe("completeness", () => {
  it("an empty scope with nothing called fails the default, and says so", () => {
    const outcome = evaluatePredicate(
      transcript([], { calls: [] }),
      rule({ toolName: "create_view" })
    );
    expect(outcome).toMatchObject({ passed: false });
    expect(outcome.status).toBeUndefined();
    expect(outcome.reason).toContain('"create_view" returned no results');
  });

  it("an empty scope with nothing called passes min 0 / max 0", () => {
    const outcome = evaluatePredicate(
      transcript([], { calls: [] }),
      rule({ min: 0, max: 0 })
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain(
      "no tool returned a result, so no result matched"
    );
  });

  it("an empty scope whose calls carry no result is unscored, for every bound", () => {
    for (const bounds of [{}, { min: 0, max: 0 }, { min: 0, max: 5 }]) {
      const outcome = evaluatePredicate(
        transcript([], {
          calls: [{ toolName: "create_view", arguments: {} }],
        }),
        rule(bounds)
      );
      expect(outcome).toMatchObject({ passed: false, status: "error" });
      expect(outcome.reason).toContain("carry no tool result");
    }
  });

  it("an uncaptured channel is unscored, never 'returned no results'", () => {
    const outcome = evaluatePredicate(
      { toolCalls: [] },
      rule({ min: 0, max: 0 })
    );
    expect(outcome).toMatchObject({ passed: false, status: "error" });
    expect(outcome.reason).toContain("no tool results captured");
  });

  describe("a partial capture", () => {
    const partial = (results: TranscriptToolResult[]) =>
      transcript(results, { capture: "partial" });

    it("still passes on a match it read, when there is no max", () => {
      const outcome = evaluatePredicate(
        partial([result({ text: "Idea Build Ship" })]),
        rule()
      );
      expect(outcome.passed).toBe(true);
    });

    it("cannot fail 'no result matched' — the dropped rows may match", () => {
      const outcome = evaluatePredicate(
        partial([result({ text: "unrelated" })]),
        rule()
      );
      expect(outcome).toMatchObject({ passed: false, status: "error" });
      expect(outcome.reason).toContain("the capture is incomplete");
    });

    it("cannot pass a ceiling — the dropped rows may exceed it", () => {
      const outcome = evaluatePredicate(
        partial([result({ text: "unrelated" })]),
        rule({ min: 0, max: 0 })
      );
      expect(outcome).toMatchObject({ passed: false, status: "error" });
    });

    it("still fails a ceiling it has already seen exceeded", () => {
      const outcome = evaluatePredicate(
        partial([result({ text: "Idea Build Ship" })]),
        rule({ min: 0, max: 0 })
      );
      expect(outcome).toMatchObject({ passed: false });
      expect(outcome.status).toBeUndefined();
      expect(outcome.reason).toContain("allowed at most 0");
    });
  });

  describe("a result truncated for storage", () => {
    const truncated = result({ text: "Idea Build Ship", truncated: true });

    it("is unreadable without a path, even when its kept text matches", () => {
      // The kept prefix is not the result: `$` would anchor on our cut.
      expect(encodeResultSubject(truncated, undefined)).toEqual({
        kind: "unreadable",
        reason: "truncated",
      });
      const outcome = evaluatePredicate(transcript([truncated]), rule());
      expect(outcome).toMatchObject({ passed: false, status: "error" });
      expect(outcome.reason).toContain("1 could not be read");
    });

    it("does not block a verdict it cannot change", () => {
      const outcome = evaluatePredicate(
        transcript([truncated, result({ text: "Idea Build Ship" })]),
        rule()
      );
      expect(outcome.passed).toBe(true);
    });

    it("is graded on structuredContent when a path is set", () => {
      const outcome = evaluatePredicate(
        transcript([
          result({
            text: "x".repeat(10),
            truncated: true,
            structuredContent: { elements: "Idea Build Ship" },
          }),
        ]),
        rule({ path: "/elements" })
      );
      expect(outcome.passed).toBe(true);
    });
  });
});

describe("bounded encoding", () => {
  it("keeps the whole subject, separators included, within the budget", () => {
    const text = "a".repeat(10);
    const payload = { k: "v" }; // `{"k":"v"}` is 9 characters
    const subject = `${text}\n{"k":"v"}`;
    expect(
      encodeResultSubject(
        result({ text, structuredContent: payload }),
        undefined,
        subject.length
      )
    ).toEqual({ kind: "subject", text: subject });
    expect(
      encodeResultSubject(
        result({ text, structuredContent: payload }),
        undefined,
        subject.length - 1
      )
    ).toEqual({ kind: "unreadable", reason: "overBudget" });
  });

  it("makes a result whose parts add up past the budget unreadable, never a match", () => {
    const half = "Idea Build Ship " + "x".repeat(MAX_MATCH_SUBJECT_CHARS / 2);
    const outcome = evaluatePredicate(
      transcript([result({ text: half, structuredContent: { more: half } })]),
      rule()
    );
    expect(outcome).toMatchObject({ passed: false, status: "error" });
    expect(outcome.reason).toContain("1 could not be read");
  });

  it("makes an oversized value at a path unreadable", () => {
    expect(
      encodeResultSubject(
        result({
          structuredContent: {
            elements: "x".repeat(MAX_MATCH_SUBJECT_CHARS + 1),
          },
        }),
        "elements"
      )
    ).toEqual({ kind: "unreadable", reason: "overBudget" });
  });

  it("reads a result with no content at all as the empty subject", () => {
    expect(encodeResultSubject(result(), undefined)).toEqual({
      kind: "subject",
      text: "",
    });
  });

  it("(a|a)*b over a full-budget text returns a result", () => {
    const outcome = evaluatePredicate(
      transcript([result({ text: "a".repeat(MAX_MATCH_SUBJECT_CHARS) })]),
      rule({ patterns: ["(a|a)*b"], flags: undefined })
    );
    expect(outcome).toMatchObject({ passed: false });
    expect(outcome.status).toBeUndefined();
  });
});

describe("redaction", () => {
  const secret = "hunter2-correct-horse-battery";

  it('never prints the value at path "/apiKey"', () => {
    const outcome = evaluatePredicate(
      transcript([result({ structuredContent: { apiKey: secret } })]),
      rule({ path: "/apiKey", patterns: ["^expected$"], flags: undefined })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).not.toContain(secret);
    expect(outcome.reason).toContain('{"apiKey":"«redacted»"}');
  });

  it("keeps key-aware redaction when the whole payload is shown", () => {
    const outcome = evaluatePredicate(
      transcript([result({ structuredContent: { q: "x", password: secret } })]),
      rule({ patterns: ["never-present"] })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).not.toContain(secret);
    expect(outcome.reason).toContain('"password":"«redacted»"');
  });

  it("scrubs a credential inside a structured string value", () => {
    const outcome = evaluatePredicate(
      transcript([
        result({
          structuredContent: { message: `retry with token=${secret}` },
        }),
      ]),
      rule({ patterns: ["never-present"] })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).not.toContain(secret);
    expect(outcome.reason).toContain("token=«redacted»");
  });

  it("scrubs a credential in text-only content", () => {
    const outcome = evaluatePredicate(
      transcript([result({ text: `401: invalid api_key=${secret}` })]),
      rule({ patterns: ["never-present"] })
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).not.toContain(secret);
  });

  it("scrubs a token-like literal in a displayed pattern", () => {
    const token = "sk-live-abcdefghijklmnop";
    const outcome = evaluatePredicate(
      transcript([result({ text: "nothing" })]),
      rule({ patterns: [token] })
    );
    expect(outcome.reason).not.toContain(token);
    expect((outcome.predicate as Rule).patterns).toEqual([token]);
  });
});

describe("schema", () => {
  it("accepts a rule with no toolName", () => {
    expect(predicateSchema.safeParse(rule()).success).toBe(true);
  });

  it.each([
    ["an empty toolName", { toolName: "" }],
    ["no patterns", { patterns: [] }],
    ["a lookahead", { patterns: ["(?=a)"] }],
    ["min 0 alone", { min: 0 }],
    ["a path without a leading slash", { path: "elements" }],
    ["a two-key path", { path: "/a/b" }],
    ["an empty path (the root)", { path: "" }],
  ])("rejects %s", (_label, over) => {
    expect(predicateSchema.safeParse(rule(over as Partial<Rule>)).success).toBe(
      false
    );
  });

  it("says min 0 needs a max in terms of results", () => {
    const parsed = predicateSchema.safeParse(rule({ min: 0 }));
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("no result matches");
  });

  it("grades a rule that bypassed the schema as unscored, not failed", () => {
    for (const malformed of [
      { ...rule(), patterns: [] },
      { ...rule(), toolName: "" },
      { ...rule(), path: "elements" },
      { ...rule(), min: 0 },
    ]) {
      const outcome = evaluatePredicate(
        transcript([result({ text: "Idea Build Ship" })]),
        malformed as Rule
      );
      expect(outcome).toMatchObject({ passed: false, status: "error" });
    }
  });
});

describe("turn scope", () => {
  it("is case-only, like toolResultContains: a turn slice carries no results", () => {
    expect(isTurnScopablePredicateKind("toolResultMatches")).toBe(false);
    expect(TURN_SCOPABLE_PREDICATE_KINDS).not.toContain("toolResultMatches");
    expect(isTurnScopablePredicateKind("toolResultContains")).toBe(false);
    const results = evaluateTurnChecks([
      {
        promptIndex: 0,
        checks: [rule()],
        transcript: transcript([result({ text: "Idea Build Ship" })]),
      },
    ]);
    expect(results).toEqual([]);
  });
});

describe("scoring", () => {
  it("digests its own implementation marker beside the rule", () => {
    const authored = rule({ role: "advisory" });
    const definition = predicateScoreDefinition(authored, { ordinal: 0 });
    expect(definition.implementationHash).toBe(
      canonicalDigest({
        ...TOOL_RESULT_MATCHES_IMPLEMENTATION,
        rule: stripCheckPolicy(authored),
      })
    );
    expect(definition.implementationHash).not.toBe(
      canonicalDigest({
        ...TOOL_INPUT_MATCHES_IMPLEMENTATION,
        rule: stripCheckPolicy(authored),
      })
    );
    expect(definition.scorerId).toBe("predicate:toolResultMatches#0");
  });

  it("projects an unscored verdict as an error, not a 0", async () => {
    const outcome = await runEvaluatorsProjected([assertion(rule())], {
      ...context,
      transcript: transcript([result({ text: "x", truncated: true })]),
    });
    expect(outcome[0]).toMatchObject({ status: "error" });
    expect(outcome[0].score).toBeUndefined();
  });

  it("scores a real failure as 0", async () => {
    const outcome = await runEvaluatorsProjected([assertion(rule())], {
      ...context,
      transcript: transcript([result({ text: "Idea" })]),
    });
    expect(outcome[0]).toMatchObject({ status: "scored", score: 0 });
  });
});
