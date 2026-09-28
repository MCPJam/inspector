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
  TranscriptToolCall,
} from "../src/predicates/types";
import {
  canonicalDigest,
  canonicalJson,
  canonicalJsonBounded,
} from "../src/contract/canonical";
import { predicateScoreDefinition } from "../src/contract/adapters";
import { stripCheckPolicy } from "../src/predicates/policy";
import {
  encodeCallSubject,
  MAX_TOOL_ARGUMENT_SUBJECT_CHARS,
  TOOL_ARGUMENTS_MATCH_IMPLEMENTATION,
  toolArgumentsMatchVerdict,
} from "../src/predicates/tool-arguments-match";

type Rule = Extract<Predicate, { type: "toolArgumentsMatch" }>;

const rule = (over: Partial<Rule> = {}): Rule => ({
  type: "toolArgumentsMatch",
  toolName: "create_view",
  patterns: ["Idea", "Build", "Ship"],
  flags: "i",
  argument: "elements",
  ...over,
});

const call = (args: Record<string, unknown>, toolName = "create_view") =>
  ({ toolName, arguments: args }) satisfies TranscriptToolCall;

const transcript = (
  ...toolCalls: TranscriptToolCall[]
): IterationTranscript => ({
  toolCalls,
});

const diagram = (...labels: string[]) => ({
  elements: labels.map((text, index) => ({ id: `n${index}`, text })),
});

const context = {
  version: 1 as const,
  scenario: { title: "case" },
  trace: { messages: [] },
};

describe("one call, all patterns", () => {
  it("fails when the three labels are split across three calls", () => {
    const result = evaluatePredicate(
      transcript(
        call(diagram("Idea")),
        call(diagram("Build")),
        call(diagram("Ship"))
      ),
      rule()
    );
    expect(result).toMatchObject({ passed: false });
    expect(result.status).toBeUndefined();
    expect(result.reason).toContain(
      '"create_view" called 3×, none matched all 3 patterns'
    );
  });

  it("passes when one call carries all three", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("idea", "BUILD", "Ship"))),
      rule()
    );
    expect(result).toMatchObject({ passed: true });
    expect(result.reason).toContain("1 matched all 3 patterns");
  });

  it("treats alternation inside one pattern as 'either'", () => {
    const either = rule({ patterns: ["SVG|Excalidraw"], argument: undefined });
    for (const word of ["svg", "excalidraw"]) {
      expect(
        evaluatePredicate(transcript(call({ format: word })), either).passed
      ).toBe(true);
    }
    expect(
      evaluatePredicate(transcript(call({ format: "png" })), either).passed
    ).toBe(false);
  });

  it("matches the whole arguments object as canonical JSON when argument is unset", () => {
    // Sorted keys, no whitespace: the author can rely on `"a":1,"b":2`.
    const result = evaluatePredicate(
      transcript(call({ b: 2, a: 1 })),
      rule({ patterns: ['^\\{"a":1,"b":2\\}$'], argument: undefined })
    );
    expect(result.passed).toBe(true);
  });

  it("matches a non-string argument as canonical JSON", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("Idea"))),
      rule({ patterns: ['"text":"Idea"'], flags: undefined })
    );
    expect(result.passed).toBe(true);
  });

  it("never matches a call that lacks the argument, and says so", () => {
    const result = evaluatePredicate(
      transcript(call({ other: "Idea Build Ship" })),
      rule()
    );
    expect(result.passed).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.reason).toContain('1 call had no "elements" argument');
  });

  it("applies the shared flags to every pattern", () => {
    const noFlags = rule({ flags: undefined });
    expect(
      evaluatePredicate(
        transcript(call(diagram("idea", "build", "ship"))),
        noFlags
      ).passed
    ).toBe(false);
    const dotAll = rule({
      patterns: ["start.end"],
      flags: "s",
      argument: "text",
    });
    expect(
      evaluatePredicate(transcript(call({ text: "start\nend" })), dotAll).passed
    ).toBe(true);
    const multiline = rule({
      patterns: ["^second$"],
      flags: "m",
      argument: "text",
    });
    expect(
      evaluatePredicate(transcript(call({ text: "first\nsecond" })), multiline)
        .passed
    ).toBe(true);
  });

  it("only reads calls to the named tool", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("Idea", "Build", "Ship"), "other_tool")),
      rule()
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('"create_view" was never called');
  });
});

describe("counting — min and max count MATCHING calls", () => {
  it("passes one matching call among ten that do not", () => {
    const calls = [
      call(diagram("Idea", "Build", "Ship")),
      ...Array.from({ length: 10 }, () => call(diagram("unrelated"))),
    ];
    const result = evaluatePredicate(transcript(...calls), rule());
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('"create_view" called 11×, 1 matched');
  });

  it("min 0 / max 0 passes when calls happened but none matched", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("Idea")), call(diagram("Build"))),
      rule({ min: 0, max: 0 })
    );
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("expected no matching call");
  });

  it("min 0 / max 0 fails when one call matches, naming the ceiling", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("Idea", "Build", "Ship")), call(diagram("x"))),
      rule({ min: 0, max: 0 })
    );
    expect(result).toMatchObject({ passed: false });
    expect(result.status).toBeUndefined();
    expect(result.reason).toContain(
      '"create_view" called 2×, 1 matched all 3 patterns in its "elements" argument, allowed at most 0'
    );
  });

  it("min 0 / max 0 passes on a tool never called, and says it was not called", () => {
    const result = evaluatePredicate(transcript(), rule({ min: 0, max: 0 }));
    expect(result.passed).toBe(true);
    expect(result.reason).toContain('"create_view" was not called');
  });

  it("the default fails a tool never called, and says so", () => {
    const result = evaluatePredicate(transcript(), rule());
    expect(result).toMatchObject({ passed: false });
    expect(result.reason).toContain('"create_view" was never called');
    expect(result.reason).toContain("at least 1 matching call(s)");
  });

  it("fails too few matching calls with the exact count", () => {
    const result = evaluatePredicate(
      transcript(call(diagram("Idea", "Build", "Ship")), call(diagram("x"))),
      rule({ min: 2 })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain(
      '"create_view" called 2×, 1 matched all 3 patterns'
    );
    expect(result.reason).toContain("expected at least 2 matching call(s)");
  });

  it("fails too many matching calls against a range", () => {
    const matching = call(diagram("Idea", "Build", "Ship"));
    const result = evaluatePredicate(
      transcript(matching, matching, matching),
      rule({ min: 1, max: 2 })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("3 matched");
    expect(result.reason).toContain("allowed at most 2");
  });

  it.each([
    [{ matched: 1, unreadable: 0 }, { min: 1, max: undefined }, "pass"],
    [{ matched: 1, unreadable: 5 }, { min: 1, max: undefined }, "pass"],
    [{ matched: 0, unreadable: 0 }, { min: 1, max: undefined }, "fail"],
    [{ matched: 0, unreadable: 1 }, { min: 1, max: undefined }, "unscored"],
    [{ matched: 0, unreadable: 0 }, { min: 0, max: 0 }, "pass"],
    [{ matched: 0, unreadable: 1 }, { min: 0, max: 0 }, "unscored"],
    [{ matched: 1, unreadable: 1 }, { min: 0, max: 0 }, "fail"],
    [{ matched: 2, unreadable: 1 }, { min: 2, max: 3 }, "pass"],
    [{ matched: 2, unreadable: 2 }, { min: 2, max: 3 }, "unscored"],
    [{ matched: 1, unreadable: 0 }, { min: 2, max: 3 }, "fail"],
  ] as const)("verdict for %j under %j is %s", (tally, bounds, verdict) => {
    expect(toolArgumentsMatchVerdict(tally, bounds)).toBe(verdict);
  });
});

describe("bounded canonical encoding", () => {
  /** A small deterministic PRNG, so a failure reproduces. */
  function prng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  const STRINGS = [
    "",
    "plain",
    'quote " and \\ backslash',
    "newline\n tab\t nul\u0000 bell\u0007",
    "unicode é ü 中文",
    "emoji 😀 and a lone surrogate \ud800",
    "line separator   paragraph  ",
    "</script>",
  ];
  const NUMBERS = [
    0,
    -0,
    1,
    -1,
    0.1,
    1e21,
    1e-7,
    -1.5e-300,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_VALUE,
    123456789.123,
  ];

  function randomValue(next: () => number, depth: number): unknown {
    const roll = next();
    if (depth > 4 || roll < 0.35) {
      const leaf = Math.floor(next() * 5);
      if (leaf === 0) return null;
      if (leaf === 1) return next() < 0.5;
      if (leaf === 2) return NUMBERS[Math.floor(next() * NUMBERS.length)];
      return STRINGS[Math.floor(next() * STRINGS.length)];
    }
    if (roll < 0.65) {
      const length = Math.floor(next() * 5);
      const array: unknown[] = [];
      for (let i = 0; i < length; i += 1) {
        // `undefined` inside an array must become `null` on both sides.
        array.push(next() < 0.1 ? undefined : randomValue(next, depth + 1));
      }
      if (next() < 0.1) array.length += 2; // trailing holes
      return array;
    }
    const record: Record<string, unknown> =
      next() < 0.1 ? Object.create(null) : {};
    const size = Math.floor(next() * 5);
    for (let i = 0; i < size; i += 1) {
      const key =
        STRINGS[Math.floor(next() * STRINGS.length)] + String(i) + "Zaá";
      // `undefined` properties are dropped on both sides.
      record[key] = next() < 0.1 ? undefined : randomValue(next, depth + 1);
    }
    return record;
  }

  it("is byte-identical to canonicalJson under the budget (fuzz)", () => {
    const next = prng(20260927);
    for (let i = 0; i < 2_000; i += 1) {
      const value = randomValue(next, 0);
      if (value === undefined) continue;
      const expected = canonicalJson(value);
      expect(canonicalJsonBounded(value, Number.POSITIVE_INFINITY)).toEqual({
        ok: true,
        json: expected,
      });
      // The budget is inclusive at exactly the output's length and refuses
      // one character less — the boundary, not a neighbourhood of it.
      expect(canonicalJsonBounded(value, expected.length)).toEqual({
        ok: true,
        json: expected,
      });
      if (expected.length > 0) {
        expect(canonicalJsonBounded(value, expected.length - 1)).toEqual({
          ok: false,
          reason: "overBudget",
        });
      }
    }
  });

  it("agrees on key order, sparse arrays and nested structure", () => {
    const value = {
      z: [1, , 3],
      a: { y: undefined, b: [{ d: 1, c: 2 }] },
      é: "x",
      A: -0,
    };
    expect(canonicalJsonBounded(value, Number.POSITIVE_INFINITY)).toEqual({
      ok: true,
      json: canonicalJson(value),
    });
  });

  it("reports what canonicalJson refuses as uncanonical, never throws", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      Number.NaN,
      { n: Number.POSITIVE_INFINITY },
      cycle,
      new Date(0),
      { f: () => 1 },
      { big: BigInt(1) },
    ]) {
      expect(() => canonicalJson(value)).toThrow();
      expect(canonicalJsonBounded(value, 1_000)).toMatchObject({
        ok: false,
        reason: "uncanonical",
      });
    }
  });

  it("stops traversing as soon as the budget is spent", () => {
    let reads = 0;
    const huge = Array.from({ length: 10_000 }, () => {
      const element = {};
      Object.defineProperty(element, "v", {
        enumerable: true,
        get() {
          reads += 1;
          return "x".repeat(50);
        },
      });
      return element;
    });
    expect(canonicalJsonBounded(huge, 1_000)).toEqual({
      ok: false,
      reason: "overBudget",
    });
    // ~58 characters per element: the writer gave up after a couple of dozen
    // reads, not ten thousand.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(30);
  });

  it("refuses an oversized string before escaping it", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const huge = "a".repeat(1_000_000);
      expect(canonicalJsonBounded({ huge }, 1_000)).toEqual({
        ok: false,
        reason: "overBudget",
      });
      expect(stringify.mock.calls.some(([arg]) => arg === huge)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("makes an over-budget call unreadable, never a match", () => {
    const text = `Idea Build Ship ${"x".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS)}`;
    expect(encodeCallSubject({ text }, "text")).toEqual({
      kind: "unreadable",
      reason: "overBudget",
    });
    expect(encodeCallSubject({ text }, undefined)).toEqual({
      kind: "unreadable",
      reason: "overBudget",
    });
    const result = evaluatePredicate(
      transcript(call({ text })),
      rule({ argument: "text" })
    );
    // One unreadable call could be the match `min: 1` needs, or not: neither
    // a pass nor a fail can rest on it.
    expect(result).toMatchObject({ passed: false, status: "error" });
    expect(result.reason).toContain("1 could not be read");
  });

  it("keeps a string argument at exactly the budget readable", () => {
    const text = "a".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS);
    expect(encodeCallSubject({ text }, "text")).toEqual({
      kind: "subject",
      text,
    });
  });

  it("an unreadable call does not block a verdict it cannot change", () => {
    const huge = { elements: "x".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS + 1) };
    const result = evaluatePredicate(
      transcript(call(diagram("Idea", "Build", "Ship")), call(huge)),
      rule()
    );
    expect(result.passed).toBe(true);
  });

  it("treats an uncanonical argument as unreadable", () => {
    expect(
      encodeCallSubject({ elements: { n: Number.NaN } }, "elements")
    ).toEqual({ kind: "unreadable", reason: "uncanonical" });
  });
});

describe("redaction", () => {
  it('never prints the value of argument "apiKey"', () => {
    const secret = "hunter2-correct-horse-battery";
    const result = evaluatePredicate(
      transcript(call({ apiKey: secret })),
      rule({ argument: "apiKey", patterns: ["^expected$"], flags: undefined })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).not.toContain(secret);
    expect(result.reason).toContain('{"apiKey":"«redacted»"}');
  });

  it("keeps key-aware redaction when the whole arguments object is shown", () => {
    const secret = "hunter2-correct-horse-battery";
    const result = evaluatePredicate(
      transcript(call({ query: "x", password: secret })),
      rule({ argument: undefined, patterns: ["never-present"] })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).not.toContain(secret);
    expect(result.reason).toContain('"password":"«redacted»"');
  });

  it("scrubs a token-like literal in a displayed pattern", () => {
    const token = "sk-live-abcdefghijklmnop";
    const result = evaluatePredicate(
      transcript(call({ auth: "nothing" })),
      rule({ argument: undefined, patterns: [token] })
    );
    expect(result.passed).toBe(false);
    expect(result.reason).not.toContain(token);
    expect(result.reason).toContain("«redacted»");
    // The stored rule keeps what the author wrote.
    expect((result.predicate as Rule).patterns).toEqual([token]);
  });

  it("truncates a long displayed pattern", () => {
    const long = "a".repeat(400);
    const result = evaluatePredicate(
      transcript(call({ text: "b" })),
      rule({ argument: "text", patterns: [long] })
    );
    expect(result.reason).not.toContain(long);
    expect(result.reason).toContain("…(+280 chars)");
  });
});

describe("a pathological pattern stays linear", () => {
  it("(a|a)*b over a 100k-character subject returns a result", () => {
    const text = "a".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS);
    const result = evaluatePredicate(
      transcript(call({ text })),
      rule({ argument: "text", patterns: ["(a|a)*b"], flags: undefined })
    );
    expect(result).toMatchObject({ passed: false });
    expect(result.status).toBeUndefined();
  });

  it("(a|a)*$ and .*.*.*= evaluate too", () => {
    const text = "a".repeat(50_000);
    expect(
      evaluatePredicate(
        transcript(call({ text })),
        rule({ argument: "text", patterns: ["(a|a)*$"], flags: undefined })
      ).passed
    ).toBe(true);
    expect(
      evaluatePredicate(
        transcript(call({ text })),
        rule({ argument: "text", patterns: [".*.*.*="], flags: undefined })
      ).passed
    ).toBe(false);
  });
});

describe("schema", () => {
  it("accepts named groups, which translate to re2 syntax", () => {
    expect(
      predicateSchema.safeParse(rule({ patterns: ["(?<label>Idea)"] })).success
    ).toBe(true);
  });

  it.each([
    ["a lookahead", { patterns: ["(?=a)"] }],
    ["a backreference", { patterns: ["(a)\\1"] }],
    ["an unbalanced group", { patterns: ["("] }],
    ["no patterns", { patterns: [] }],
    ["nine patterns", { patterns: Array.from({ length: 9 }, () => "a") }],
    ["an empty pattern", { patterns: [""] }],
    ["a 513-character pattern", { patterns: ["a".repeat(513)] }],
    ["an unsupported flag", { flags: "g" }],
    ["a non-canonical flag order", { flags: "si" }],
    ["min 0 alone", { min: 0 }],
    ["max 0 alone", { max: 0 }],
    ["max below min", { min: 2, max: 1 }],
    ["a fractional min", { min: 1.5 }],
    ["an empty argument", { argument: "" }],
  ])("rejects %s", (_label, over) => {
    expect(predicateSchema.safeParse(rule(over as Partial<Rule>)).success).toBe(
      false
    );
  });

  it("grades a rule that bypassed the schema as unscored, not failed", () => {
    for (const malformed of [
      { ...rule(), patterns: [] },
      { ...rule(), patterns: ["(?=a)"] },
      { ...rule(), min: 0 },
    ]) {
      const result = evaluatePredicate(
        transcript(call(diagram("Idea", "Build", "Ship"))),
        malformed as Rule
      );
      expect(result).toMatchObject({ passed: false, status: "error" });
    }
  });
});

describe("turn scope", () => {
  it("is turn-scopable and grades each turn's own calls", () => {
    expect(isTurnScopablePredicateKind("toolArgumentsMatch")).toBe(true);
    expect(TURN_SCOPABLE_PREDICATE_KINDS).toContain("toolArgumentsMatch");
    const results = evaluateTurnChecks([
      {
        promptIndex: 0,
        checks: [rule()],
        transcript: transcript(call(diagram("Idea", "Build", "Ship"))),
      },
      {
        promptIndex: 1,
        checks: [rule()],
        transcript: transcript(call(diagram("Idea"))),
      },
    ]);
    expect(results.map((r) => r.passed)).toEqual([true, false]);
    expect(results[1]).toMatchObject({
      scope: { kind: "turn", promptIndex: 1 },
    });
  });
});

describe("scoring", () => {
  it("digests the implementation beside the rule", () => {
    const authored = rule({ role: "advisory" });
    const definition = predicateScoreDefinition(authored, { ordinal: 0 });
    expect(definition.implementationHash).toBe(
      canonicalDigest({
        ...TOOL_ARGUMENTS_MATCH_IMPLEMENTATION,
        rule: stripCheckPolicy(authored),
      })
    );
    expect(definition.implementationHash).not.toBe(
      canonicalDigest(stripCheckPolicy(authored))
    );
    expect(definition.scorerId).toBe("predicate:toolArgumentsMatch#0");
  });

  it("projects an unreadable-decided verdict as an error, not a 0", async () => {
    const result = await runEvaluatorsProjected(
      [assertion(rule({ argument: "text" }))],
      {
        ...context,
        transcript: transcript(
          call({ text: "x".repeat(MAX_TOOL_ARGUMENT_SUBJECT_CHARS + 1) })
        ),
      }
    );
    expect(result[0]).toMatchObject({ status: "error" });
    expect(result[0].score).toBeUndefined();
  });

  it("scores a real failure as 0", async () => {
    const result = await runEvaluatorsProjected([assertion(rule())], {
      ...context,
      transcript: transcript(call(diagram("Idea"))),
    });
    expect(result[0]).toMatchObject({ status: "scored", score: 0 });
  });
});
