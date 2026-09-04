/**
 * Unit coverage for the evaluation contract's canonicalization and derivation.
 *
 * The parity test (`score-contract-parity.test.ts`) proves the SDK and the
 * backend agree; this proves the SDK's own rules — the ones every producer
 * inherits by being forced through `finalizeScoreResult`.
 */

import { describe, expect, it } from "vitest";
import {
  CanonicalJsonError,
  canonicalDigest,
  canonicalJson,
  sha256Hex,
} from "../src/contract/canonical.js";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  errorScoreResult,
  evaluationConfigHash,
  finalizeScoreResult,
  notApplicableScoreResult,
  resolveScoreDefinition,
  scorePassed,
  skippedScoreResult,
} from "../src/contract/derive.js";
import {
  MAX_ERROR_LENGTH,
  MAX_EVIDENCE_ENTRIES,
  MAX_EVIDENCE_ENTRY_LENGTH,
  MAX_RATIONALE_LENGTH,
  type ScoreDefinition,
} from "../src/contract/types.js";
import { scoreResultSchema } from "../src/contract/schemas.js";
import {
  fromGoalCompletionCase,
  fromLegacyTestOutcome,
  fromToolMatchResult,
  generatedPredicateScorerId,
  legacyTestScoreDefinition,
  predicateScoreDefinition,
  scoreResultFromPredicateResult,
  toolMatchScoreDefinition,
} from "../src/contract/adapters.js";
import { MATCH_OPTIONS_DEFAULTS } from "../src/matchers.js";

const GATING: ScoreDefinition = {
  scorerId: "gate",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-1",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const ADVISORY: ScoreDefinition = {
  scorerId: "judge",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-2",
  deterministic: false,
  passThreshold: 0.7,
  role: "advisory",
  model: "anthropic/claude-sonnet-4-6",
};

describe("canonicalJson", () => {
  it("sorts object keys and is insensitive to construction order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}'
    );
  });

  it("drops `undefined` object properties so absent == unset", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1 })).toBe('{"a":1}');
  });

  it("preserves array positions by writing `undefined` as null", () => {
    // Dropping it would silently renumber every later element.
    expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson({ v: -0 })).toBe(canonicalJson({ v: 0 }));
  });

  it("throws on non-finite numbers instead of coercing to null", () => {
    // `JSON.stringify(NaN)` is "null", which would let two different configs
    // share a digest.
    expect(() => canonicalJson({ v: NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ v: Infinity })).toThrow(CanonicalJsonError);
  });

  it("throws on undefined at the root and on unsupported types", () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ v: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ v: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Date(0))).toThrow(CanonicalJsonError);
  });

  it("escapes strings the way JSON does", () => {
    expect(canonicalJson({ "a\"b": "c\nd" })).toBe('{"a\\"b":"c\\nd"}');
  });

  it("serializes sparse-array holes as null, not as empty fields", () => {
    // `.map()` SKIPS holes and `join` then emits `"[1,,3]"` — not JSON, and a
    // shape distinct configs could collide on.
    const sparse = [1, , 3] as unknown[];
    expect(canonicalJson(sparse)).toBe("[1,null,3]");
    expect(JSON.parse(canonicalJson(sparse))).toEqual([1, null, 3]);
  });

  it("reports a cycle instead of overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
  });

  it("allows the same object twice in different branches", () => {
    // Shared, not circular — a `finally`-scoped ancestor set must not confuse
    // the two.
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe(
      '{"a":{"v":1},"b":{"v":1}}'
    );
  });

  it("round-trips through JSON.parse", () => {
    const value = { z: [1, { b: null, a: "x" }], y: true };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
  });
});

describe("sha256Hex / canonicalDigest", () => {
  it("matches the published SHA-256 of 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("digests equal-by-canonicalization values identically", () => {
    expect(canonicalDigest({ a: 1, b: 2 })).toBe(canonicalDigest({ b: 2, a: 1 }));
  });
});

describe("resolveScoreDefinition", () => {
  it("fails closed for gating scorers", () => {
    const resolved = resolveScoreDefinition(GATING);
    expect(resolved.onError).toBe("fail");
    expect(resolved.onSkipped).toBe("fail");
  });

  it("defaults advisory scorers to ignore", () => {
    const resolved = resolveScoreDefinition(ADVISORY);
    expect(resolved.onError).toBe("ignore");
    expect(resolved.onSkipped).toBe("ignore");
  });

  it("honors an explicit override on a gating scorer", () => {
    const resolved = resolveScoreDefinition({ ...GATING, onError: "ignore" });
    expect(resolved.onError).toBe("ignore");
    // …without dragging onSkipped along: the two policies are independent.
    expect(resolved.onSkipped).toBe("fail");
  });
});

describe("evaluationConfigHash", () => {
  it("is independent of definition order", () => {
    const a = [GATING, ADVISORY].map(resolveScoreDefinition);
    const b = [ADVISORY, GATING].map(resolveScoreDefinition);
    expect(evaluationConfigHash(a)).toBe(evaluationConfigHash(b));
  });

  it("changes when any definition changes", () => {
    const base = [GATING].map(resolveScoreDefinition);
    const bumped = [{ ...GATING, implementationHash: "impl-9" }].map(
      resolveScoreDefinition
    );
    expect(evaluationConfigHash(base)).not.toBe(evaluationConfigHash(bumped));
  });
});

describe("buildEvaluationConfigSnapshot", () => {
  it("resolves definitions and keeps authored order while hashing sorted", () => {
    const snapshot = buildEvaluationConfigSnapshot([ADVISORY, GATING]);
    expect(snapshot.definitions.map((d) => d.scorerId)).toEqual([
      "judge",
      "gate",
    ]);
    expect(snapshot.definitions[0].onError).toBe("ignore");
    expect(snapshot.hash).toBe(
      buildEvaluationConfigSnapshot([GATING, ADVISORY]).hash
    );
  });

  it("rejects duplicate scorerIds at construction", () => {
    // An ambiguous join is one where a gating policy silently resolves to an
    // advisory twin — caught here rather than downstream, where the snapshot
    // merely fails validation and the run loses its scores with no reason.
    expect(() =>
      buildEvaluationConfigSnapshot([GATING, { ...ADVISORY, scorerId: "gate" }])
    ).toThrow(/Duplicate scorerId "gate"/);
  });

  it("collapses an identical twin instead of rejecting it", () => {
    // Same id AND same content is one definition described twice, not an
    // ambiguity: two anonymous predicate scorers wrapping the same predicate
    // mint the same content-derived id by design. Rejecting that would fail a
    // config that is merely redundant, and every row either one produces still
    // joins to the surviving entry.
    const twinned = buildEvaluationConfigSnapshot([GATING, ADVISORY, GATING]);
    expect(twinned.definitions).toHaveLength(2);
    expect(twinned.hash).toBe(
      buildEvaluationConfigSnapshot([GATING, ADVISORY]).hash
    );
  });

  it("accepts already-resolved definitions idempotently", () => {
    const once = buildEvaluationConfigSnapshot([GATING]);
    const twice = buildEvaluationConfigSnapshot(once.definitions);
    expect(twice.hash).toBe(once.hash);
  });
});

describe("scorePassed", () => {
  it("passes AT the threshold, not only above it", () => {
    expect(scorePassed(0.7, 0.7)).toBe(true);
    expect(scorePassed(0.69, 0.7)).toBe(false);
    expect(scorePassed(0, 0)).toBe(true);
  });
});

describe("finalizeScoreResult", () => {
  const gate = resolveScoreDefinition(GATING);
  const judge = resolveScoreDefinition(ADVISORY);

  it("derives `passed` and never takes it from the caller", () => {
    const row = finalizeScoreResult(judge, { kind: "scored", value: 0.9 });
    expect(row.status).toBe("scored");
    expect(row.passed).toBe(true);
    expect(row.value).toBe(0.9);
    expect(row.passThreshold).toBe(0.7);
  });

  it("stamps the definitionHash so the row can be joined", () => {
    const row = finalizeScoreResult(gate, { kind: "scored", value: 1 });
    expect(row.definitionHash).toBe(definitionHash(gate));
  });

  it("turns an out-of-range value into an ERROR, never a clamped score", () => {
    // Clamping 1.5 to 1 would promote a malfunctioning judge to a passing gate.
    const high = finalizeScoreResult(judge, { kind: "scored", value: 1.5 });
    expect(high.status).toBe("error");
    expect(high.value).toBeUndefined();
    expect(high.passed).toBeUndefined();
    expect(high.error).toContain("1.5");

    const low = finalizeScoreResult(judge, { kind: "scored", value: -1 });
    expect(low.status).toBe("error");
  });

  it("turns a non-numeric value into an error", () => {
    const row = finalizeScoreResult(judge, {
      kind: "scored",
      value: NaN,
    });
    expect(row.status).toBe("error");
    expect(row.error).toContain("non-numeric");
  });

  it("truncates rationale to the documented bound", () => {
    const row = finalizeScoreResult(judge, {
      kind: "scored",
      value: 1,
      rationale: "x".repeat(MAX_RATIONALE_LENGTH + 500),
    });
    expect(row.rationale).toHaveLength(MAX_RATIONALE_LENGTH);
    expect(row.rationale?.endsWith("…")).toBe(true);
  });

  it("truncates evidence by count AND by entry length", () => {
    const row = finalizeScoreResult(judge, {
      kind: "scored",
      value: 1,
      evidence: Array.from({ length: MAX_EVIDENCE_ENTRIES + 7 }, () =>
        "y".repeat(MAX_EVIDENCE_ENTRY_LENGTH + 50)
      ),
    });
    expect(row.evidence).toHaveLength(MAX_EVIDENCE_ENTRIES);
    for (const entry of row.evidence ?? []) {
      expect(entry.length).toBeLessThanOrEqual(MAX_EVIDENCE_ENTRY_LENGTH);
    }
  });

  it("passes skipped and not_applicable through with no verdict", () => {
    const skipped = finalizeScoreResult(judge, {
      kind: "skipped",
      rationale: "iteration errored before scoring",
    });
    expect(skipped.status).toBe("skipped");
    expect(skipped.value).toBeUndefined();
    expect(skipped.passed).toBeUndefined();
    expect(skipped.rationale).toBe("iteration errored before scoring");

    const na = finalizeScoreResult(gate, { kind: "not_applicable" });
    expect(na.status).toBe("not_applicable");
    expect(na.passed).toBeUndefined();
  });

  it("produces rows that satisfy the schema for every status", () => {
    const rows = [
      finalizeScoreResult(judge, { kind: "scored", value: 0.9 }),
      finalizeScoreResult(judge, { kind: "scored", value: 0.1 }),
      finalizeScoreResult(judge, { kind: "skipped" }),
      finalizeScoreResult(gate, { kind: "not_applicable" }),
      errorScoreResult(judge, new Error("boom")),
    ];
    for (const row of rows) {
      const parsed = scoreResultSchema.safeParse(row);
      if (!parsed.success) {
        throw new Error(
          `${row.status} row failed validation: ${JSON.stringify(parsed.error.issues)}`
        );
      }
    }
  });
});

describe("errorScoreResult / skippedScoreResult / notApplicableScoreResult", () => {
  const judge = resolveScoreDefinition(ADVISORY);

  it("records an Error's message and truncates it", () => {
    const row = errorScoreResult(judge, new Error("z".repeat(900)));
    expect(row.status).toBe("error");
    expect(row.error).toHaveLength(MAX_ERROR_LENGTH);
  });

  it("describes a non-Error throw without producing an empty reason", () => {
    expect(errorScoreResult(judge, "").error).toBe("unknown error");
    expect(errorScoreResult(judge, { code: 7 }).error).toBe("[object Object]");
  });

  it("carries the definition's model onto non-scored rows", () => {
    expect(skippedScoreResult(judge).model).toBe(ADVISORY.model);
    expect(notApplicableScoreResult(judge).model).toBe(ADVISORY.model);
  });
});

describe("adapters", () => {
  it("mints a positional id only when the author named none", () => {
    const predicate = {
      type: "responseContains",
      needle: "refund",
    } as const;
    const generated = predicateScoreDefinition(predicate, { ordinal: 3 });
    expect(generated.scorerId).toBe(
      generatedPredicateScorerId(predicate, 3)
    );
    expect(generated.scorerId).toBe("predicate:responseContains#3");
    expect(generated.idSource).toBe("generated");

    const named = predicateScoreDefinition(predicate, {
      id: "refund-mentioned",
      ordinal: 3,
    });
    expect(named.scorerId).toBe("refund-mentioned");
    expect(named.idSource).toBe("explicit");
  });

  it("hashes the predicate itself, so editing it changes the config hash", () => {
    const a = predicateScoreDefinition(
      { type: "responseContains", needle: "refund issued" },
      { ordinal: 0 }
    );
    const b = predicateScoreDefinition(
      { type: "responseContains", needle: "refund processed" },
      { ordinal: 0 }
    );
    expect(a.implementationHash).not.toBe(b.implementationHash);
  });

  it("projects a predicate verdict to 0|1 against a threshold of 1", () => {
    const definition = resolveScoreDefinition(
      predicateScoreDefinition(
        { type: "noToolErrors" },
        { id: "no-tool-errors", ordinal: 0 }
      )
    );
    const passing = scoreResultFromPredicateResult(definition, {
      predicate: { type: "noToolErrors" },
      passed: true,
      reason: "no tool errors observed",
    });
    expect(passing.value).toBe(1);
    expect(passing.passed).toBe(true);
    expect(passing.rationale).toBe("no tool errors observed");

    const failing = scoreResultFromPredicateResult(definition, {
      predicate: { type: "noToolErrors" },
      passed: false,
      reason: "1 tool error",
      scope: { kind: "turn", promptIndex: 2 },
    });
    expect(failing.value).toBe(0);
    expect(failing.passed).toBe(false);
    expect(failing.scope).toEqual({ kind: "turn", promptIndex: 2 });
  });

  it("hashes tool-match expectations AND the matcher policy", () => {
    const base = toolMatchScoreDefinition({
      expectedToolCalls: [{ toolName: "search" }],
      matchOptions: MATCH_OPTIONS_DEFAULTS,
    });
    const strict = toolMatchScoreDefinition({
      expectedToolCalls: [{ toolName: "search" }],
      matchOptions: { ...MATCH_OPTIONS_DEFAULTS, toolCallOrder: "strict" },
    });
    // Same expectations, different verdict on the same transcript ⇒ different
    // evaluation config.
    expect(base.implementationHash).not.toBe(strict.implementationHash);
  });

  it("summarizes a failing tool match in the rationale", () => {
    const definition = resolveScoreDefinition(
      toolMatchScoreDefinition({
        expectedToolCalls: [{ toolName: "search" }],
        matchOptions: MATCH_OPTIONS_DEFAULTS,
      })
    );
    const row = fromToolMatchResult(definition, {
      missing: [{ toolName: "search", arguments: {} }],
      extra: [{ toolName: "browse", arguments: {} }],
      outOfOrder: [],
      argumentMismatches: [],
      passed: false,
    });
    expect(row.passed).toBe(false);
    expect(row.rationale).toContain("missing search");
    expect(row.rationale).toContain("extra browse");
  });

  it("projects the legacy test() boolean", () => {
    const definition = resolveScoreDefinition(legacyTestScoreDefinition());
    expect(fromLegacyTestOutcome(definition, true).passed).toBe(true);
    expect(fromLegacyTestOutcome(definition, false).passed).toBe(false);
    expect(definition.scorerId).toBe("legacy:test");
  });

  it("DISCARDS a judge row's self-asserted `passed`", () => {
    const definition = resolveScoreDefinition(ADVISORY);
    const row = fromGoalCompletionCase(definition, {
      caseKey: "hash:abc",
      score: 0.2,
      passed: true, // the judge claims a pass…
      reason: "mostly fine",
      rubricHits: ["greeted the user"],
    });
    // …the threshold is authoritative.
    expect(row.value).toBe(0.2);
    expect(row.passed).toBe(false);
    expect(row.evidence).toEqual(["greeted the user"]);
  });
});
