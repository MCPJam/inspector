import { describe, it, expect } from "vitest";
import {
  allPredicatesPassed,
  evaluatePredicate,
  evaluatePredicates,
} from "../src/predicates/evaluate";
import type { IterationTranscript, Predicate } from "../src/predicates/types";

/** Minimal transcript builder so each row states only what it exercises. */
function transcript(over: Partial<IterationTranscript> = {}): IterationTranscript {
  return { toolCalls: [], ...over };
}

describe("evaluatePredicate — table driven", () => {
  type Row = {
    name: string;
    transcript: IterationTranscript;
    predicate: Predicate;
    passed: boolean;
    /** substrings the reason must include (structured-reason check) */
    reasonIncludes?: string[];
  };

  const rows: Row[] = [
    // ── toolCalledWith ────────────────────────────────────────────────
    {
      name: "toolCalledWith: partial match passes despite extra args",
      transcript: transcript({
        toolCalls: [{ toolName: "book_flight", arguments: { airline: "DL", seat: "1A" } }],
      }),
      predicate: { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
      passed: true,
    },
    {
      name: "toolCalledWith: exact match passes",
      transcript: transcript({
        toolCalls: [{ toolName: "book_flight", arguments: { airline: "DL" } }],
      }),
      predicate: {
        type: "toolCalledWith",
        toolName: "book_flight",
        args: { args: { airline: "DL" }, argumentMatching: "exact" },
      },
      passed: true,
    },
    {
      name: "toolCalledWith: argument mismatch fails with structured reason",
      transcript: transcript({
        toolCalls: [{ toolName: "book_flight", arguments: { airline: "UA" } }],
      }),
      predicate: { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
      passed: false,
      reasonIncludes: ["book_flight", '"airline":"DL"', '"airline":"UA"'],
    },
    {
      name: "toolCalledWith: never called fails with 'never called' reason",
      transcript: transcript({ toolCalls: [] }),
      predicate: { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
      passed: false,
      reasonIncludes: ["never called"],
    },
    {
      name: "toolCalledWith: minCount requires N matching calls (fail)",
      transcript: transcript({
        toolCalls: [{ toolName: "search", arguments: { q: "x" } }],
      }),
      predicate: { type: "toolCalledWith", toolName: "search", args: { args: {} }, minCount: 2 },
      passed: false,
      reasonIncludes: ["≥2×"],
    },
    {
      name: "toolCalledWith: minCount 0 is rejected, not treated as a disabled gate",
      transcript: transcript({ toolCalls: [] }),
      predicate: {
        type: "toolCalledWith",
        toolName: "search",
        args: { args: {} },
        minCount: 0,
      },
      passed: false,
      reasonIncludes: ["invalid minCount"],
    },
    {
      name: "toolCalledWith: minCount satisfied by repeated calls (pass)",
      transcript: transcript({
        toolCalls: [
          { toolName: "search", arguments: { q: "x" } },
          { toolName: "search", arguments: { q: "y" } },
        ],
      }),
      predicate: { type: "toolCalledWith", toolName: "search", args: { args: {} }, minCount: 2 },
      passed: true,
    },

    // ── toolCalledAtLeastOnce ─────────────────────────────────────────
    {
      name: "toolCalledAtLeastOnce: present across multi-turn passes",
      transcript: transcript({
        toolCalls: [
          { toolName: "search", arguments: {} },
          { toolName: "book_flight", arguments: {} },
        ],
      }),
      predicate: { type: "toolCalledAtLeastOnce", toolName: "book_flight" },
      passed: true,
    },
    {
      name: "toolCalledAtLeastOnce: absent fails",
      transcript: transcript({ toolCalls: [{ toolName: "search", arguments: {} }] }),
      predicate: { type: "toolCalledAtLeastOnce", toolName: "book_flight" },
      passed: false,
      reasonIncludes: ["never called"],
    },

    // ── toolNeverCalled ───────────────────────────────────────────────
    {
      name: "toolNeverCalled: forbidden tool absent passes",
      transcript: transcript({ toolCalls: [{ toolName: "search", arguments: {} }] }),
      predicate: { type: "toolNeverCalled", toolName: "delete_account" },
      passed: true,
    },
    {
      name: "toolNeverCalled: forbidden tool present fails",
      transcript: transcript({
        toolCalls: [{ toolName: "delete_account", arguments: {} }],
      }),
      predicate: { type: "toolNeverCalled", toolName: "delete_account" },
      passed: false,
      reasonIncludes: ["forbidden", "delete_account"],
    },
    {
      name: "toolNeverCalled: missing toolName fails closed (not silently 'not called')",
      transcript: transcript({ toolCalls: [{ toolName: "search", arguments: {} }] }),
      predicate: { type: "toolNeverCalled" } as unknown as Predicate,
      passed: false,
      reasonIncludes: ["non-empty toolName"],
    },

    // ── responseContains ──────────────────────────────────────────────
    {
      name: "responseContains: case-insensitive default passes",
      transcript: transcript({ finalAssistantMessage: "Your Refund Issued today." }),
      predicate: { type: "responseContains", needle: "refund issued" },
      passed: true,
    },
    {
      name: "responseContains: case-sensitive mismatch fails",
      transcript: transcript({ finalAssistantMessage: "Your Refund Issued today." }),
      predicate: { type: "responseContains", needle: "refund issued", caseSensitive: true },
      passed: false,
    },
    {
      name: "responseContains: missing message fails",
      transcript: transcript({}),
      predicate: { type: "responseContains", needle: "refund" },
      passed: false,
    },
    {
      name: "responseContains: empty needle fails closed (not always-true includes(''))",
      transcript: transcript({ finalAssistantMessage: "anything at all" }),
      predicate: { type: "responseContains", needle: "" },
      passed: false,
      reasonIncludes: ["non-empty needle"],
    },

    // ── responseMatches ───────────────────────────────────────────────
    {
      name: "responseMatches: regex matches passes",
      transcript: transcript({ finalAssistantMessage: "Order #4823 confirmed" }),
      predicate: { type: "responseMatches", pattern: "#\\d{4} confirmed" },
      passed: true,
    },
    {
      name: "responseMatches: no match fails",
      transcript: transcript({ finalAssistantMessage: "Order pending" }),
      predicate: { type: "responseMatches", pattern: "#\\d{4} confirmed" },
      passed: false,
    },
    {
      name: "responseMatches: over-long message fails closed (no misleading truncated match)",
      transcript: transcript({ finalAssistantMessage: "x".repeat(100_001) }),
      predicate: { type: "responseMatches", pattern: "x$" },
      passed: false,
      reasonIncludes: ["exceeds"],
    },
    {
      name: "responseMatches: invalid regex fails with reason",
      transcript: transcript({ finalAssistantMessage: "anything" }),
      predicate: { type: "responseMatches", pattern: "([unterminated" },
      passed: false,
      reasonIncludes: ["invalid regex"],
    },
    {
      name: "responseMatches: missing pattern fails closed (no empty-regex match-all)",
      transcript: transcript({ finalAssistantMessage: "anything at all" }),
      predicate: { type: "responseMatches" } as unknown as Predicate,
      passed: false,
      reasonIncludes: ["non-empty string pattern"],
    },
    {
      name: "responseMatches: empty pattern fails closed",
      transcript: transcript({ finalAssistantMessage: "anything at all" }),
      predicate: { type: "responseMatches", pattern: "" },
      passed: false,
      reasonIncludes: ["non-empty string pattern"],
    },
    {
      name: "responseMatches: nested quantifier `(a+)+` fails closed (ReDoS guard)",
      transcript: transcript({ finalAssistantMessage: "a".repeat(30) + "!" }),
      predicate: { type: "responseMatches", pattern: "^(a+)+$" },
      passed: false,
      reasonIncludes: ["nested quantifier", "catastrophic backtracking"],
    },
    {
      name: "responseMatches: nested quantifier `(a*)*` fails closed",
      transcript: transcript({ finalAssistantMessage: "aaaa" }),
      predicate: { type: "responseMatches", pattern: "(a*)*" },
      passed: false,
      reasonIncludes: ["nested quantifier"],
    },
    {
      name: "responseMatches: non-capturing nested quantifier `(?:x+){2,}` fails closed",
      transcript: transcript({ finalAssistantMessage: "xxxxxx" }),
      predicate: { type: "responseMatches", pattern: "(?:x+){2,}" },
      passed: false,
      reasonIncludes: ["nested quantifier"],
    },
    {
      name: "responseMatches: nested `{m,n}` inside quantified group `(a{2,})+` fails closed",
      transcript: transcript({ finalAssistantMessage: "aaaa" }),
      predicate: { type: "responseMatches", pattern: "(a{2,})+" },
      passed: false,
      reasonIncludes: ["nested quantifier"],
    },
    {
      name: "responseMatches: safe quantified group `(foo)+` still evaluates",
      transcript: transcript({ finalAssistantMessage: "foofoofoo" }),
      predicate: { type: "responseMatches", pattern: "(foo)+" },
      passed: true,
    },
    {
      name: "responseMatches: sibling quantifiers `a+b+` still evaluate (no nesting)",
      transcript: transcript({ finalAssistantMessage: "aaabbb" }),
      predicate: { type: "responseMatches", pattern: "a+b+" },
      passed: true,
    },

    // ── noToolErrors (the isError vs JSON-RPC distinction) ─────────────
    {
      name: "noToolErrors: no errors passes",
      transcript: transcript({ toolCalls: [{ toolName: "search", arguments: {} }] }),
      predicate: { type: "noToolErrors" },
      passed: true,
    },
    {
      name: "noToolErrors: content-error (isError:true) fails and is labeled",
      transcript: transcript({
        toolErrors: [{ toolName: "book_flight", kind: "content-error", message: "sold out" }],
      }),
      predicate: { type: "noToolErrors" },
      passed: false,
      reasonIncludes: ["content-error", "book_flight"],
    },
    {
      name: "noToolErrors: protocol-error (JSON-RPC) fails and is labeled",
      transcript: transcript({
        toolErrors: [{ toolName: "book_flight", kind: "protocol-error", message: "method not found" }],
      }),
      predicate: { type: "noToolErrors" },
      passed: false,
      reasonIncludes: ["protocol-error"],
    },
    {
      name: "noToolErrors: both kinds reported together",
      transcript: transcript({
        toolErrors: [
          { toolName: "a", kind: "content-error" },
          { toolName: "b", kind: "protocol-error" },
        ],
      }),
      predicate: { type: "noToolErrors" },
      passed: false,
      reasonIncludes: ["content-error", "protocol-error", "2 tool error"],
    },

    // ── finalAssistantMessageNonEmpty ─────────────────────────────────
    {
      name: "finalAssistantMessageNonEmpty: non-empty passes",
      transcript: transcript({ finalAssistantMessage: "Done." }),
      predicate: { type: "finalAssistantMessageNonEmpty" },
      passed: true,
    },
    {
      name: "finalAssistantMessageNonEmpty: whitespace-only fails",
      transcript: transcript({ finalAssistantMessage: "   \n  " }),
      predicate: { type: "finalAssistantMessageNonEmpty" },
      passed: false,
    },
    {
      name: "finalAssistantMessageNonEmpty: absent fails",
      transcript: transcript({}),
      predicate: { type: "finalAssistantMessageNonEmpty" },
      passed: false,
    },

    // ── tokenBudgetUnder ──────────────────────────────────────────────
    {
      name: "tokenBudgetUnder: under budget via totalTokens passes",
      transcript: transcript({ usage: { totalTokens: 900 } }),
      predicate: { type: "tokenBudgetUnder", tokens: 1000 },
      passed: true,
    },
    {
      name: "tokenBudgetUnder: over budget fails",
      transcript: transcript({ usage: { totalTokens: 1500 } }),
      predicate: { type: "tokenBudgetUnder", tokens: 1000 },
      passed: false,
    },
    {
      name: "tokenBudgetUnder: boundary (equal) fails (strict <)",
      transcript: transcript({ usage: { totalTokens: 1000 } }),
      predicate: { type: "tokenBudgetUnder", tokens: 1000 },
      passed: false,
    },
    {
      name: "tokenBudgetUnder: falls back to input+output sum",
      transcript: transcript({ usage: { inputTokens: 400, outputTokens: 300 } }),
      predicate: { type: "tokenBudgetUnder", tokens: 1000 },
      passed: true,
    },
    {
      name: "tokenBudgetUnder: uses input+output when totalTokens is 0 (not bypassed)",
      transcript: transcript({
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 0 },
      }),
      predicate: { type: "tokenBudgetUnder", tokens: 100 },
      passed: false,
    },
    {
      name: "tokenBudgetUnder: missing usage fails closed",
      transcript: transcript({}),
      predicate: { type: "tokenBudgetUnder", tokens: 1000 },
      passed: false,
      reasonIncludes: ["unavailable"],
    },
  ];

  for (const row of rows) {
    it(row.name, () => {
      const result = evaluatePredicate(row.transcript, row.predicate);
      expect(result.passed).toBe(row.passed);
      expect(result.predicate).toEqual(row.predicate);
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
      for (const needle of row.reasonIncludes ?? []) {
        expect(result.reason).toContain(needle);
      }
    });
  }
});

describe("evaluatePredicates — aggregate verdict", () => {
  const baseTranscript: IterationTranscript = {
    toolCalls: [{ toolName: "book_flight", arguments: { airline: "DL" } }],
    finalAssistantMessage: "Booked on DL. Refund issued if cancelled.",
    usage: { totalTokens: 500 },
    toolErrors: [],
  };

  it("all predicates pass → aggregate passes", () => {
    const predicates: Predicate[] = [
      { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
      { type: "responseContains", needle: "refund issued" },
      { type: "noToolErrors" },
      { type: "tokenBudgetUnder", tokens: 1000 },
    ];
    const results = evaluatePredicates(baseTranscript, predicates);
    expect(results).toHaveLength(4);
    expect(allPredicatesPassed(results)).toBe(true);
  });

  it("one predicate fails → aggregate fails", () => {
    const predicates: Predicate[] = [
      { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
      { type: "responseContains", needle: "this text is absent" },
    ];
    const results = evaluatePredicates(baseTranscript, predicates);
    expect(allPredicatesPassed(results)).toBe(false);
    expect(results.filter((r) => !r.passed)).toHaveLength(1);
  });

  it("a malformed predicate fails closed instead of throwing", () => {
    const results = evaluatePredicates(baseTranscript, [
      { type: "toolCalledWith", toolName: "x" } as unknown as Predicate,
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.passed).toBe(false);
    expect(results[0]!.reason).toContain("malformed predicate");
    expect(allPredicatesPassed(results)).toBe(false);
  });

  it("empty predicate set passes vacuously", () => {
    expect(evaluatePredicates(baseTranscript, [])).toEqual([]);
    expect(evaluatePredicates(baseTranscript, undefined)).toEqual([]);
    expect(allPredicatesPassed([])).toBe(true);
  });
});

describe("reason redaction + bounding (persisted to Convex metadata)", () => {
  it("redacts sensitive-keyed values from actual tool args", () => {
    const result = evaluatePredicate(
      {
        toolCalls: [
          {
            toolName: "book_flight",
            arguments: { airline: "UA", api_key: "sk-secret-abc123", token: "t-xyz" },
          },
        ],
      },
      { type: "toolCalledWith", toolName: "book_flight", args: { args: { airline: "DL" } } },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("«redacted»");
    expect(result.reason).not.toContain("sk-secret-abc123");
    expect(result.reason).not.toContain("t-xyz");
    // Non-sensitive keys still surface for diagnosis.
    expect(result.reason).toContain("UA");
  });

  it("bounds a huge actual-arg blob and the overall reason", () => {
    const huge = "x".repeat(5000);
    const result = evaluatePredicate(
      { toolCalls: [{ toolName: "search", arguments: { q: huge } }] },
      { type: "toolCalledWith", toolName: "search", args: { args: { q: "needle" } } },
    );
    expect(result.passed).toBe(false);
    expect(result.reason.length).toBeLessThanOrEqual(600);
    expect(result.reason).toContain("…(+");
  });

  it("truncates long tool error messages", () => {
    const longMsg = "boom ".repeat(500);
    const result = evaluatePredicate(
      { toolCalls: [], toolErrors: [{ toolName: "t", kind: "protocol-error", message: longMsg }] },
      { type: "noToolErrors" },
    );
    expect(result.passed).toBe(false);
    expect(result.reason.length).toBeLessThanOrEqual(600);
    expect(result.reason).toContain("protocol-error");
  });

  it("caps the number of calls/errors listed with a '+N more' marker", () => {
    const calls = Array.from({ length: 5 }, (_, i) => ({
      toolName: "search",
      arguments: { i },
    }));
    const result = evaluatePredicate(
      { toolCalls: calls },
      { type: "toolCalledWith", toolName: "search", args: { args: { found: true } } },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("+2 more");
  });

  it("scrubs sensitive-keyed values from the persisted PredicateResult.predicate", () => {
    // The runner writes `result.predicate` verbatim into
    // `testIteration.metadata.predicates`, so an authored predicate whose
    // `args.args` includes a sensitive key would leak into Convex without
    // sanitization in pass()/fail().
    const result = evaluatePredicate(
      {
        toolCalls: [
          {
            toolName: "call_api",
            arguments: {
              authorization: "Bearer eyJsecret",
              api_key: "sk-test-12345",
              endpoint: "/v1/widgets",
            },
          },
        ],
      },
      {
        type: "toolCalledWith",
        toolName: "call_api",
        args: {
          args: {
            authorization: "Bearer eyJsecret",
            api_key: "sk-test-12345",
            // non-sensitive — must survive so the persisted row is still useful.
            endpoint: "/v1/widgets",
          },
        },
      },
    );
    expect(result.passed).toBe(true);
    const persisted = result.predicate;
    if (persisted.type !== "toolCalledWith") throw new Error("unexpected type");
    expect(persisted.args.args.authorization).toBe("«redacted»");
    expect(persisted.args.args.api_key).toBe("«redacted»");
    expect(persisted.args.args.endpoint).toBe("/v1/widgets");
    expect(JSON.stringify(persisted)).not.toContain("eyJsecret");
    expect(JSON.stringify(persisted)).not.toContain("sk-test-12345");
  });
});
