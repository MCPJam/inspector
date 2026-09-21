/**
 * Parity + pinned-hash test for the versioned evaluation contract.
 *
 * Two jobs, both cross-repo:
 *
 *  1. **Validator parity.** The Zod schemas here and the hand-mirrored Convex
 *     `v.*` validators in `mcpjam-backend/convex/lib/scoreContract.ts` cannot be
 *     compared directly (Convex default-runtime code may not import the SDK
 *     main entry). Both sides load the SAME fixture file and assert their own
 *     validator accepts every `accept` row and rejects every `reject` row.
 *
 *  2. **Cross-runtime hash pinning.** The `__digests` block holds LITERAL
 *     digests. Both sides assert their implementation reproduces them, rather
 *     than recomputing an expectation — which would prove only that each side
 *     agrees with itself. This is the assertion that makes the backend's
 *     integrity check and its idempotency-conflict detection sound: if the two
 *     canonicalizations drift, a run's `evaluationConfigHash` would fail to
 *     verify against definitions that are in fact identical.
 *
 * The fixture is copied VERBATIM into the backend repo; see its `__readme`.
 */

import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/score-contract-parity-fixtures.json" with { type: "json" };
import {
  evaluationConfigSnapshotSchema,
  resolvedScoreDefinitionSchema,
  scoreResultSchema,
} from "../src/contract/schemas.js";
import {
  allGatingScorersPassed,
  definitionHash,
  evaluationConfigHash,
  resolveScoreDefinition,
} from "../src/contract/derive.js";
import type { ScoreDefinition } from "../src/contract/types.js";

type FixtureRow = Record<string, unknown> & {
  __kind: "result" | "definition" | "snapshot";
  __label: string;
  __why?: string;
};

type DigestDefinitionRow = {
  __label: string;
  definition: Record<string, unknown>;
  definitionHash: string;
};

type DigestConfigRow = {
  __label: string;
  definitions: Record<string, unknown>[];
  evaluationConfigHash: string;
};

type FixturesFile = {
  __readme: string;
  accept: FixtureRow[];
  reject: FixtureRow[];
  __digests: {
    definitions: DigestDefinitionRow[];
    configs: DigestConfigRow[];
  };
  __verdicts: {
    __readme: string;
    cases: Array<{
      __label: string;
      __why?: string;
      definitions: Record<string, unknown>[];
      rows: Record<string, unknown>[];
      expected: {
        passed: boolean;
        disagreeing: string[];
        unresolved: string[];
      };
    }>;
  };
};

const data = fixtures as unknown as FixturesFile;

/**
 * Strip every `__`-prefixed annotation, recursively.
 *
 * The load rule the backend mirrors: `__label` / `__why` / `__kind` are fixture
 * metadata, and both validators reject unknown fields, so a payload that still
 * carries them would be rejected for the wrong reason — turning an `accept` row
 * into a false failure and, worse, a `reject` row into a false success.
 */
function stripAnnotations<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripAnnotations(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (key.startsWith("__")) continue;
      out[key] = stripAnnotations(entry);
    }
    return out as unknown as T;
  }
  return value;
}

const VALIDATORS = {
  result: scoreResultSchema,
  definition: resolvedScoreDefinitionSchema,
  snapshot: evaluationConfigSnapshotSchema,
} as const;

function validate(row: FixtureRow) {
  const validator = VALIDATORS[row.__kind];
  if (!validator) {
    throw new Error(`Unknown fixture __kind "${row.__kind}" on "${row.__label}"`);
  }
  return validator.safeParse(stripAnnotations(row));
}

describe("score contract parity fixtures — Zod (@mcpjam/sdk side)", () => {
  it("fixtures file has a README, both cohorts, and the pinned digests", () => {
    expect(typeof data.__readme).toBe("string");
    expect(data.accept.length).toBeGreaterThan(0);
    expect(data.reject.length).toBeGreaterThan(0);
    expect(data.__digests.definitions.length).toBeGreaterThan(0);
    expect(data.__digests.configs.length).toBeGreaterThan(0);
  });

  it("covers all three validators in BOTH cohorts", () => {
    for (const kind of ["result", "definition", "snapshot"] as const) {
      expect(
        data.accept.filter((row) => row.__kind === kind).length,
        `expected ≥1 accept row for __kind "${kind}"`
      ).toBeGreaterThan(0);
      expect(
        data.reject.filter((row) => row.__kind === kind).length,
        `expected ≥1 reject row for __kind "${kind}"`
      ).toBeGreaterThan(0);
    }
  });

  it("covers every ScoreStatus in the accept cohort", () => {
    const statuses = new Set(
      data.accept
        .filter((row) => row.__kind === "result")
        .map((row) => row.status)
    );
    expect([...statuses].sort()).toEqual([
      "error",
      "not_applicable",
      "scored",
      "skipped",
    ]);
  });

  describe("accept[]", () => {
    for (const row of data.accept) {
      it(`accepts: ${row.__label}`, () => {
        const parsed = validate(row);
        if (!parsed.success) {
          throw new Error(
            `Expected accept, got reject for "${row.__label}":\n` +
              JSON.stringify(parsed.error.issues, null, 2)
          );
        }
        expect(parsed.success).toBe(true);
      });
    }
  });

  describe("reject[]", () => {
    for (const row of data.reject) {
      it(`rejects: ${row.__label}`, () => {
        const parsed = validate(row);
        if (parsed.success) {
          throw new Error(
            `Expected reject, got accept for "${row.__label}"`
          );
        }
        expect(parsed.success).toBe(false);
      });
    }
  });

  /**
   * The derivation contradiction is the reason this contract has a
   * `superRefine` at all, so it is asserted by REASON, not merely by "something
   * failed". A row that got rejected because of an unrelated typo would still
   * pass a bare `success === false` check while leaving the real guard untested.
   */
  it("rejects a contradicted `passed` FOR THE DERIVATION REASON", () => {
    const row = data.reject.find((entry) =>
      entry.__label.startsWith(
        "result — passed CONTRADICTS value >= passThreshold"
      )
    );
    expect(row, "the load-bearing reject row is missing").toBeDefined();

    const parsed = validate(row!);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const issues = parsed.error.issues;
    // Exactly one problem, and it is the derivation — not a missing field, not
    // a range violation, not an unknown key.
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toEqual(["passed"]);
    expect(issues[0].message).toContain("`passed` must equal");
    expect(issues[0].message).toContain("0.2 >= 0.7 is false, got true");
  });
});

describe("score contract pinned digests — cross-runtime hash parity", () => {
  for (const row of data.__digests.definitions) {
    it(`definitionHash matches the pinned constant: ${row.__label}`, () => {
      const authored = stripAnnotations(row.definition) as ScoreDefinition;
      expect(definitionHash(resolveScoreDefinition(authored))).toBe(
        row.definitionHash
      );
    });
  }

  for (const row of data.__digests.configs) {
    it(`evaluationConfigHash matches the pinned constant: ${row.__label}`, () => {
      const authored = stripAnnotations(
        row.definitions
      ) as unknown as ScoreDefinition[];
      expect(
        evaluationConfigHash(authored.map(resolveScoreDefinition))
      ).toBe(row.evaluationConfigHash);
    });
  }

  /**
   * The pinned constants above are only meaningful if the equivalences they
   * encode actually hold — a fixture where every row happened to carry the same
   * literal would pass the loop above and prove nothing. These assert the
   * RELATIONSHIPS the plan requires, by label.
   */
  function digestFor(labelPrefix: string): string {
    const row = data.__digests.definitions.find((entry) =>
      entry.__label.startsWith(labelPrefix)
    );
    if (!row) throw new Error(`missing pinned definition "${labelPrefix}"`);
    const authored = stripAnnotations(row.definition) as ScoreDefinition;
    return definitionHash(resolveScoreDefinition(authored));
  }

  function configDigestFor(labelPrefix: string): string {
    const row = data.__digests.configs.find((entry) =>
      entry.__label.startsWith(labelPrefix)
    );
    if (!row) throw new Error(`missing pinned config "${labelPrefix}"`);
    const authored = stripAnnotations(
      row.definitions
    ) as unknown as ScoreDefinition[];
    return evaluationConfigHash(authored.map(resolveScoreDefinition));
  }

  it("omitted defaults and explicit defaults digest identically", () => {
    expect(digestFor("D2")).toBe(digestFor("D1"));
    // …on the advisory branch of the default too.
    expect(digestFor("D7")).toBe(digestFor("D6"));
  });

  it("permuted key order digests identically", () => {
    expect(digestFor("D3")).toBe(digestFor("D1"));
  });

  it("a presentation-only `label` does not change the digest", () => {
    expect(digestFor("D4")).toBe(digestFor("D1"));
  });

  it("a differing implementationHash DOES change the digest", () => {
    expect(digestFor("D5")).not.toBe(digestFor("D1"));
  });

  it("promoting a judge from advisory to gating DOES change the digest", () => {
    expect(digestFor("D8")).not.toBe(digestFor("D6"));
  });

  it("permuted definition order digests identically at config level", () => {
    expect(configDigestFor("C2")).toBe(configDigestFor("C1"));
  });

  it("a changed role in the set DOES change the config digest", () => {
    expect(configDigestFor("C3")).not.toBe(configDigestFor("C1"));
  });
});

// =============================================================================
// Cross-runtime VERDICT parity — `allGatingScorersPassed` (B3b).
//
// The arithmetic the score contract becomes authoritative with. THIS copy
// DECIDES an iteration's result at grading mode `enforce`; the backend's
// hand-mirror in `convex/lib/scoreContract.ts` VERIFIES that decision against
// the rows it persisted. Both sides run these fixture cases, because a verifier
// using different arithmetic from the deriver is checking the wrong thing —
// and would downgrade honest runs.
// =============================================================================
describe("cross-runtime verdict parity — allGatingScorersPassed", () => {
  for (const fixture of data.__verdicts.cases) {
    it(`derives the pinned verdict: ${fixture.__label}`, () => {
      const definitions = stripAnnotations(fixture.definitions).map((entry) =>
        resolveScoreDefinition(entry as never)
      );
      // The join is BY HASH, so each row is stamped with the hash its NAMED
      // definition resolves to. A row naming no definition stays unjoinable —
      // a case the fixtures cover deliberately.
      const byScorerId = new Map(
        definitions.map((definition) => [
          definition.scorerId,
          definitionHash(definition),
        ])
      );
      const scores = stripAnnotations(fixture.rows).map(
        (row) =>
          ({
            ...row,
            definitionHash:
              byScorerId.get((row as { scorerId: string }).scorerId) ??
              "unjoinable",
          }) as never
      );

      const verdict = allGatingScorersPassed(scores, {
        hash: evaluationConfigHash(definitions),
        definitions,
      });
      expect(verdict.passed).toBe(fixture.expected.passed);
      expect([...verdict.disagreeingScorerIds].sort()).toEqual(
        fixture.expected.disagreeing
      );
      expect([...verdict.unresolvedScorerIds].sort()).toEqual(
        fixture.expected.unresolved
      );
    });
  }
});
