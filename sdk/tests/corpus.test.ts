/**
 * Hosted corpus → local `EvalTest`.
 *
 * The property that matters most: a case a local run CANNOT execute must fail
 * loudly at construction. Silently dropping a widget step produces a test that
 * runs, passes, and measures something other than what the dashboard shows —
 * and nobody finds out, because it is green.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CORPUS_LOCK_VERSION,
  HostedOnlyCaseError,
  buildCorpus,
  evalTestFromPlatformCase,
  loadCorpusFromLock,
  resolveCaseNames,
  resolveEffectiveChecks,
  scenarioContentHash,
  sdkMatchOptionsFromPublic,
  verifyCorpusLock,
} from "../src/corpus.js";
import type { PlatformEvalCase } from "../src/platform/types.js";

const FETCHED_AT = "2026-08-15T00:00:00.000Z";

function evalCase(overrides: Partial<PlatformEvalCase> = {}): PlatformEvalCase {
  return {
    id: "case_1",
    title: "Refund flow",
    steps: [{ id: "s1", kind: "prompt", prompt: "Ask for a refund" }],
    iterations: 3,
    isNegative: false,
    models: [{ provider: "openai", model: "gpt-4o" } as never],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("evalTestFromPlatformCase", () => {
  it("materializes a prompt case with identity, polarity and expectations", () => {
    const test = evalTestFromPlatformCase(
      evalCase({
        expectedOutput: "a refund confirmation",
        steps: [
          { id: "s1", kind: "prompt", prompt: "Ask for a refund" },
          {
            id: "s2",
            kind: "assert",
            assertion: {
              type: "toolCalledWith",
              toolName: "issue_refund",
              args: { args: { orderId: "A1" } },
            },
          },
          {
            id: "s3",
            kind: "assert",
            assertion: { type: "noToolErrors" },
          },
        ],
      })
    );
    const config = test.getConfig();

    expect(config.name).toBe("Refund flow");
    // Identity rides externalCaseId, NEVER the display name.
    expect(config.externalCaseId).toBe("case_1");
    expect(config.isNegativeTest).toBe(false);
    expect(config.expectedOutput).toBe("a refund confirmation");
    // `toolCalledWith` becomes an EXPECTATION, matching hosted
    // `deriveExpectedToolCalls`; everything else stays a predicate.
    expect(config.expectedToolCalls).toEqual([
      { toolName: "issue_refund", arguments: { orderId: "A1" } },
    ]);
    expect(config.predicates?.map((p) => p.type)).toEqual(["noToolErrors"]);
  });

  it("drives the executor with every prompt, in step order", async () => {
    const seen: string[] = [];
    const executor = {
      run: vi.fn(async (prompt: string) => {
        seen.push(prompt);
        return {} as never;
      }),
    };
    const test = evalTestFromPlatformCase(
      evalCase({
        steps: [
          { id: "s1", kind: "prompt", prompt: "first" },
          { id: "s2", kind: "assert", assertion: { type: "noToolErrors" } },
          { id: "s3", kind: "prompt", prompt: "second" },
        ],
      })
    );

    await test.getConfig().test(executor as never);
    expect(seen).toEqual(["first", "second"]);
  });

  it("preserves hosted negative semantics rather than translating them", () => {
    const config = evalTestFromPlatformCase(
      evalCase({ isNegative: true })
    ).getConfig();
    expect(config.isNegativeTest).toBe(true);
    // NOT a per-tool `toolNeverCalled` predicate: the matcher already
    // implements "pass iff no tool was called".
    expect(config.predicates ?? []).toEqual([]);
  });

  const HOSTED_ONLY: Array<{ label: string; step: Record<string, unknown> }> = [
    {
      label: "a direct toolCall step",
      step: { id: "s2", kind: "toolCall", toolName: "issue_refund" },
    },
    {
      label: "a widget interact step",
      step: { id: "s2", kind: "interact", toolName: "w", action: "click" },
    },
    {
      label: "a widget assertion",
      step: {
        id: "s2",
        kind: "assert",
        assertion: { kind: "textVisible", text: "Refunded" },
      },
    },
  ];

  it.each(HOSTED_ONLY)(
    "refuses $label, naming the case and the step",
    ({ step }) => {
      let thrown: unknown;
      try {
        evalTestFromPlatformCase(
          evalCase({
            steps: [
              { id: "s1", kind: "prompt", prompt: "go" },
              step as never,
            ],
          })
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HostedOnlyCaseError);
      const error = thrown as HostedOnlyCaseError;
      expect(error.caseId).toBe("case_1");
      expect(error.stepIndex).toBe(1);
      expect(error.stepId).toBe("s2");
      // The message must carry the case and a fix — a bare "unsupported step"
      // leaves the author with nowhere to go.
      expect(error.message).toContain("Refund flow");
      expect(error.message).toContain("hosted");
    }
  );

  it("fails loudly on an unrecognized assertion instead of dropping it", () => {
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          steps: [
            { id: "s1", kind: "prompt", prompt: "go" },
            { id: "s2", kind: "assert", assertion: { type: "notARealCheck" } },
          ],
        })
      )
    ).toThrow(/unrecognized assertion at step 1/);
  });

  it("refuses a case with no steps and one with no prompt", () => {
    expect(() => evalTestFromPlatformCase(evalCase({ steps: [] }))).toThrow(
      /no steps/
    );
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          steps: [{ id: "s1", kind: "assert", assertion: { type: "noToolErrors" } }],
        })
      )
    ).toThrow(/no prompt steps/);
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({ steps: [{ id: "s1", kind: "prompt", prompt: "   " }] })
      )
    ).toThrow(/empty prompt/);
  });
});

describe("sdkMatchOptionsFromPublic", () => {
  it("inverts the server's table exhaustively", () => {
    expect(
      sdkMatchOptionsFromPublic({
        toolCallOrder: "any",
        extraToolCalls: "unlimited",
        arguments: "partial",
      })
    ).toEqual({
      toolCallOrder: "ignore",
      maxExtraToolCalls: null,
      argumentMatching: "partial",
    });
    expect(sdkMatchOptionsFromPublic({ toolCallOrder: "in-order" })).toEqual({
      toolCallOrder: "superset",
    });
    expect(sdkMatchOptionsFromPublic({ toolCallOrder: "exact" })).toEqual({
      toolCallOrder: "strict",
    });
    expect(sdkMatchOptionsFromPublic({ extraToolCalls: 0 })).toEqual({
      maxExtraToolCalls: 0,
    });
    expect(sdkMatchOptionsFromPublic(undefined)).toBeUndefined();
  });
});

describe("resolveEffectiveChecks", () => {
  const suite = [{ type: "noToolErrors" }];
  const context = { caseId: "case_1", caseTitle: "Refund flow" };

  it("inherits, replaces and extends", () => {
    expect(
      resolveEffectiveChecks(undefined, suite, context).map((c) => c.type)
    ).toEqual(["noToolErrors"]);
    expect(
      resolveEffectiveChecks(
        { mode: "replace", list: [{ type: "responseContains", needle: "ok" }] },
        suite,
        context
      ).map((c) => c.type)
    ).toEqual(["responseContains"]);
    expect(
      resolveEffectiveChecks(
        { mode: "extend", list: [{ type: "responseContains", needle: "ok" }] },
        suite,
        context
      ).map((c) => c.type)
    ).toEqual(["noToolErrors", "responseContains"]);
  });

  it("names the case and the ordinal on a bad check", () => {
    expect(() =>
      resolveEffectiveChecks(
        { mode: "replace", list: [{ type: "nope" }] },
        suite,
        context
      )
    ).toThrow(/Refund flow.*position 0/s);
  });
});

describe("scenarioContentHash", () => {
  const base = evalCase({
    steps: [
      { id: "s1", kind: "prompt", prompt: "Ask for a refund" },
      { id: "s2", kind: "assert", assertion: { type: "noToolErrors" } },
    ],
  });
  const hash = scenarioContentHash(base);

  const IGNORED: Array<{ label: string; patch: Partial<PlatformEvalCase> }> = [
    { label: "iterations", patch: { iterations: 99 } },
    { label: "models", patch: { models: [] } },
    {
      label: "intent (analytics metadata, not case content)",
      patch: { intent: "refund" },
    },
    { label: "timestamps", patch: { createdAt: 999, updatedAt: 999 } },
    {
      label: "matchOptions (evaluation config, not content)",
      patch: { matchOptions: { toolCallOrder: "exact" } as never },
    },
    {
      label: "checks (evaluation config, not content)",
      patch: { checks: { mode: "replace", list: [] } as never },
    },
  ];

  it.each(IGNORED)("ignores $label", ({ patch }) => {
    expect(scenarioContentHash({ ...base, ...patch })).toBe(hash);
  });

  it("ignores step ids and unknown wire fields", () => {
    // A server adding a cosmetic field must not churn every hash in the lock.
    expect(
      scenarioContentHash({
        ...base,
        steps: [
          {
            id: "RENAMED",
            kind: "prompt",
            prompt: "Ask for a refund",
            cosmeticServerField: "new in v9",
          },
          { id: "ALSO_RENAMED", kind: "assert", assertion: { type: "noToolErrors" } },
        ] as never,
      })
    ).toBe(hash);
  });

  const CHANGES: Array<{ label: string; patch: Partial<PlatformEvalCase> }> = [
    { label: "the title", patch: { title: "Renamed" } },
    { label: "isNegative", patch: { isNegative: true } },
    { label: "expectedOutput", patch: { expectedOutput: "something" } },
    { label: "the scenario id", patch: { scenario: "other" } },
    {
      label: "a prompt",
      patch: {
        steps: [
          { id: "s1", kind: "prompt", prompt: "Ask for a REPLACEMENT" },
          { id: "s2", kind: "assert", assertion: { type: "noToolErrors" } },
        ],
      },
    },
    {
      label: "step order",
      patch: {
        steps: [
          { id: "s2", kind: "assert", assertion: { type: "noToolErrors" } },
          { id: "s1", kind: "prompt", prompt: "Ask for a refund" },
        ],
      },
    },
  ];

  it.each(CHANGES)("changes with $label", ({ patch }) => {
    expect(scenarioContentHash({ ...base, ...patch })).not.toBe(hash);
  });
});

describe("resolveCaseNames", () => {
  it("suffixes EVERY member of a colliding group, deterministically", () => {
    const names = resolveCaseNames([
      { id: "a", title: "Same" },
      { id: "b", title: "Same" },
      { id: "c", title: "Unique" },
    ]);
    // The whole group, so which case got the bare name does not depend on
    // fetch order.
    expect(names.get("a")).toBe("Same [a]");
    expect(names.get("b")).toBe("Same [b]");
    expect(names.get("c")).toBe("Unique");
  });
});

describe("buildCorpus", () => {
  const cases = [
    evalCase({ id: "a", title: "Same" }),
    evalCase({ id: "b", title: "Same" }),
  ];

  it("produces scenario keys, and a suite that accepts colliding titles", () => {
    const corpus = buildCorpus({
      suite: { id: "suite_1", name: "Checkout" },
      cases,
      fetchedAt: FETCHED_AT,
    });
    expect(corpus.cases.map((c) => c.scenarioKey)).toEqual([
      "external:a",
      "external:b",
    ]);
    // `EvalSuite.add` rejects duplicate names, so this would throw without the
    // disambiguation.
    expect(() => corpus.toEvalSuite()).not.toThrow();
  });

  it("`unsupported: skip` records the reason instead of throwing", () => {
    const corpus = buildCorpus({
      suite: { id: "suite_1" },
      cases: [
        evalCase({ id: "ok" }),
        evalCase({
          id: "hosted",
          title: "Widget case",
          steps: [
            { id: "s1", kind: "prompt", prompt: "go" },
            { id: "s2", kind: "interact", toolName: "w", action: "click" },
          ],
        }),
      ],
      unsupported: "skip",
      fetchedAt: FETCHED_AT,
    });
    expect(corpus.cases).toHaveLength(1);
    expect(corpus.skipped).toHaveLength(1);
    expect(corpus.skipped[0].caseId).toBe("hosted");
    expect(corpus.skipped[0].reason).toContain("hosted");
  });

  it("defaults to erroring, so a dropped case cannot go unnoticed", () => {
    expect(() =>
      buildCorpus({
        suite: { id: "suite_1" },
        cases: [
          evalCase({
            steps: [
              { id: "s1", kind: "prompt", prompt: "go" },
              { id: "s2", kind: "interact", toolName: "w", action: "click" },
            ],
          }),
        ],
        fetchedAt: FETCHED_AT,
      })
    ).toThrow(HostedOnlyCaseError);
  });
});

describe("the lock", () => {
  function lockOf(cases: PlatformEvalCase[]) {
    return buildCorpus({
      suite: { id: "suite_1", name: "Checkout" },
      cases,
      fetchedAt: FETCHED_AT,
    }).lock;
  }

  it("is sorted by scenarioKey and carries an aggregate config hash", () => {
    const lock = lockOf([
      evalCase({ id: "zeta", title: "Z" }),
      evalCase({ id: "alpha", title: "A" }),
    ]);
    // Byte-stable across fetches: a lock that reorders is unreviewable.
    expect(lock.cases.map((row) => row.scenarioKey)).toEqual([
      "external:alpha",
      "external:zeta",
    ]);
    expect(lock.lockVersion).toBe(CORPUS_LOCK_VERSION);
    expect(lock.evaluationConfigHash).toMatch(/^[0-9a-f]{64}$/);
    // Per-case hashes come from the ONE existing derivation, never a re-derive.
    expect(lock.cases[0].evaluationConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports all four drift kinds", () => {
    const locked = lockOf([
      evalCase({ id: "kept" }),
      evalCase({ id: "removed", title: "Gone" }),
      evalCase({ id: "edited", title: "Edited" }),
      evalCase({ id: "regraded", title: "Regraded" }),
    ]);
    const fresh = lockOf([
      evalCase({ id: "kept" }),
      evalCase({
        id: "edited",
        title: "Edited",
        steps: [{ id: "s1", kind: "prompt", prompt: "DIFFERENT" }],
      }),
      evalCase({
        id: "regraded",
        title: "Regraded",
        // Same content, different matcher ⇒ evaluationConfigChanged, NOT
        // contentChanged. The two have different fixes.
        matchOptions: { toolCallOrder: "exact", extraToolCalls: 0 } as never,
      }),
      evalCase({ id: "added", title: "New" }),
    ]);

    expect(verifyCorpusLock(locked, fresh)).toEqual([
      { kind: "caseAdded", scenarioKey: "external:added", title: "New" },
      { kind: "contentChanged", scenarioKey: "external:edited", title: "Edited" },
      // Sorted by scenarioKey: "regraded" precedes "removed".
      {
        kind: "evaluationConfigChanged",
        scenarioKey: "external:regraded",
        title: "Regraded",
      },
      { kind: "caseRemoved", scenarioKey: "external:removed", title: "Gone" },
    ]);
  });

  it("reports nothing for an unchanged corpus", () => {
    const cases = [evalCase({ id: "a" }), evalCase({ id: "b", title: "B" })];
    expect(verifyCorpusLock(lockOf(cases), lockOf(cases))).toEqual([]);
  });

  it("round-trips offline: loadCorpusFromLock ≡ the online build", () => {
    const cases = [
      evalCase({ id: "a" }),
      evalCase({ id: "b", title: "B", isNegative: true }),
    ];
    const online = buildCorpus({
      suite: { id: "suite_1", name: "Checkout" },
      cases,
      fetchedAt: FETCHED_AT,
    });
    const offline = loadCorpusFromLock(online.lock);

    // The lock is a reproducibility record, not a checksum: rebuilding from it
    // with no network must produce the same corpus.
    expect(offline.lock).toEqual(online.lock);
    expect(offline.cases.map((c) => c.scenarioKey)).toEqual(
      online.cases.map((c) => c.scenarioKey)
    );
    expect(offline.cases.map((c) => c.test.getConfig().isNegativeTest)).toEqual(
      online.cases.map((c) => c.test.getConfig().isNegativeTest)
    );
  });
});

describe("guards the reviewers found", () => {
  it("refuses a negative case that also asserts toolCalledWith", () => {
    // Hosted allows both; the matcher cannot honour both — `evaluateToolCalls`
    // returns before reading `expected` for a negative case, so the assertion
    // would grade nothing while looking enforced.
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          isNegative: true,
          steps: [
            { id: "s1", kind: "prompt", prompt: "go" },
            {
              id: "s2",
              kind: "assert",
              assertion: {
                type: "toolCalledWith",
                toolName: "t",
                args: { args: {} },
              },
            },
          ],
        })
      )
    ).toThrow(/negative case.*toolCalledWith at step 1/s);
  });

  it("`skip` skips ONLY hosted-only cases, never malformed data", () => {
    // A broken case must fail the build even in skip mode: silently dropping
    // it produces a suite that looks complete and is not.
    expect(() =>
      buildCorpus({
        suite: { id: "s" },
        cases: [evalCase({ id: "broken", steps: [] })],
        unsupported: "skip",
        fetchedAt: FETCHED_AT,
      })
    ).toThrow(/no steps/);
  });

  it("replays suite-level checks and match options from the lock", () => {
    const online = buildCorpus({
      suite: { id: "s" },
      cases: [evalCase({ id: "inheriting" })],
      suiteChecks: [{ type: "noToolErrors" }],
      suiteMatchOptions: { toolCallOrder: "exact" },
      fetchedAt: FETCHED_AT,
    });
    const offline = loadCorpusFromLock(online.lock);

    // Without persisting the suite inputs, the rebuilt case would lose its
    // inherited check and be graded with matcher defaults — so its
    // evaluationConfigHash would differ and `--frozen` would report drift on a
    // case nobody touched.
    expect(offline.cases[0].test.getConfig().predicates?.map((p) => p.type)).toEqual(
      ["noToolErrors"]
    );
    expect(offline.cases[0].test.getConfig().matchOptions).toEqual({
      toolCallOrder: "strict",
    });
    expect(offline.lock.evaluationConfigHash).toBe(
      online.lock.evaluationConfigHash
    );
  });
});

describe("toolCalledWith conversion preserves what it cannot express", () => {
  function caseWith(assertion: Record<string, unknown>) {
    return evalTestFromPlatformCase(
      evalCase({
        steps: [
          { id: "s1", kind: "prompt", prompt: "go" },
          { id: "s2", kind: "assert", assertion },
        ],
      })
    ).getConfig();
  }

  it("converts the PLAIN case to an expectation, matching hosted", () => {
    const config = caseWith({
      type: "toolCalledWith",
      toolName: "issue_refund",
      args: { args: { orderId: "A1" } },
    });
    expect(config.expectedToolCalls).toEqual([
      { toolName: "issue_refund", arguments: { orderId: "A1" } },
    ]);
    expect(config.predicates ?? []).toEqual([]);
  });

  const UNEXPRESSIBLE: Array<{ label: string; assertion: Record<string, unknown> }> = [
    {
      label: "minCount > 1",
      assertion: {
        type: "toolCalledWith",
        toolName: "t",
        args: { args: {} },
        minCount: 3,
      },
    },
    {
      label: "exact argument matching",
      assertion: {
        type: "toolCalledWith",
        toolName: "t",
        args: { args: { a: 1 }, argumentMatching: "exact" },
      },
    },
  ];

  it.each(UNEXPRESSIBLE)(
    "keeps $label as a PREDICATE rather than under-grading it",
    ({ assertion }) => {
      const config = caseWith(assertion);
      // `expectedToolCalls` has no minCount and no per-call argumentMatching,
      // so converting would grade more loosely than the dashboard — a local
      // pass where hosted fails. The predicate engine handles both natively.
      expect(config.expectedToolCalls ?? []).toEqual([]);
      // The whole ASSERTION survives, not merely its type: checking the type
      // alone would still pass if a future conversion dropped the very
      // constraints this branch exists to preserve.
      expect(config.predicates).toEqual([assertion]);
    }
  );

  it("treats explicit defaults as plain", () => {
    const config = caseWith({
      type: "toolCalledWith",
      toolName: "t",
      args: { args: {}, argumentMatching: "partial" },
      minCount: 1,
    });
    expect(config.expectedToolCalls).toEqual([{ toolName: "t", arguments: {} }]);
    // Converted, so it must NOT also linger as a predicate — that would grade
    // the same assertion twice.
    expect(config.predicates ?? []).toEqual([]);
  });
});

describe("a negative case cannot assert a tool call, however it is expressed", () => {
  const CONTRADICTIONS: Array<{ label: string; assertion: Record<string, unknown> }> = [
    {
      label: "a plain assertion (would convert to an expectation)",
      assertion: {
        type: "toolCalledWith",
        toolName: "t",
        args: { args: {} },
      },
    },
    {
      label: "a non-plain assertion (would stay a predicate)",
      assertion: {
        type: "toolCalledWith",
        toolName: "t",
        args: { args: {} },
        minCount: 2,
      },
    },
  ];

  it.each(CONTRADICTIONS)("refuses $label", ({ assertion }) => {
    // Both routes must be refused. Guarding only the converted one leaves the
    // predicate route to demand a tool call while the negative matcher demands
    // none — every iteration fails, for a reason the author never wrote.
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          isNegative: true,
          steps: [
            { id: "s1", kind: "prompt", prompt: "go" },
            { id: "s2", kind: "assert", assertion },
          ],
        })
      )
    ).toThrow(/negative case.*toolCalledWith at step 1/s);
  });

  // The third route, and the one the step loop cannot see: effective checks
  // are resolved AFTER it, so these reach the merged config without ever
  // passing the per-step guard.
  const TOOL_CALLED_WITH = {
    type: "toolCalledWith",
    toolName: "t",
    args: { args: {} },
  };

  it("refuses a toolCalledWith arriving as a case-level check", () => {
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          isNegative: true,
          steps: [{ id: "s1", kind: "prompt", prompt: "go" }],
          checks: { mode: "replace", list: [TOOL_CALLED_WITH] },
        })
      )
    ).toThrow(/negative case.*toolCalledWith check/s);
  });

  it("refuses a toolCalledWith inherited from the suite", () => {
    // `mode: "inherit"` is the default, so a suite-level check silently
    // applies to every case — including the negative ones nobody re-read.
    expect(() =>
      evalTestFromPlatformCase(
        evalCase({
          isNegative: true,
          steps: [{ id: "s1", kind: "prompt", prompt: "go" }],
        }),
        { suiteChecks: [TOOL_CALLED_WITH] }
      )
    ).toThrow(/negative case.*toolCalledWith check/s);
  });

  it("still allows a positive case to carry the same check", () => {
    // The guard keys on `isNegative`, not on the check — a suite-level
    // toolCalledWith is perfectly valid for every non-negative case, and
    // over-refusing here would break the suites that rely on it.
    const config = evalTestFromPlatformCase(
      evalCase({
        isNegative: false,
        steps: [{ id: "s1", kind: "prompt", prompt: "go" }],
      }),
      { suiteChecks: [TOOL_CALLED_WITH] }
    ).getConfig();
    expect(config.predicates).toEqual([TOOL_CALLED_WITH]);
  });
});
