/**
 * The public v1 compare projection.
 *
 * `toRunCompareDto` is a WHITELIST, and these tests exist to keep it one. The
 * failure guarded against is not "a field is missing" — it is an internal
 * `_storage` id reaching a public caller because someone reached for a
 * passthrough to ship one more field. Once a storage id is published it can
 * never be withdrawn.
 *
 * The fixture is BYTE-IDENTICAL to `mcpjam-backend`'s
 * `tests/convex/fixtures/eval-run-compare-parity.json`, and both repos pin the
 * same SHA-256 over it. Nothing in either type system spans the gap between
 * the backend action and this projection — the transport is
 * `convex.action(... as any)` — so the fixture IS the contract. Editing one
 * copy fails both suites, which is the point.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  toRunCompareDto,
  type RunCompareBaseline,
} from "../eval-compare-projection.js";

/**
 * The SAME literal the backend's `evalRunCompareParity.test.ts` pins. Changing
 * the fixture requires updating BOTH constants and copying the bytes across in
 * one change.
 */
const EVAL_RUN_COMPARE_PARITY_SHA256 =
  "5823c2420be670bcffaa3b0bdb4e98046393b2929dce903b7aa74fcc5bbf9e02";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "__fixtures__",
  "eval-run-compare-parity.json",
);

const raw = readFileSync(FIXTURE_PATH, "utf8");
const fixture = JSON.parse(raw) as {
  expectedDiff: Record<string, unknown>;
  expectedBaselineNotFound: unknown;
  __meta: { mirror: string };
};

const BASELINE: RunCompareBaseline = {
  policy: "previous_completed",
  baseRunId: "run_parity_base",
};

function dto() {
  return toRunCompareDto(fixture.expectedDiff, BASELINE);
}

describe("eval compare fixture parity", () => {
  it("hashes to the same literal the backend pins", () => {
    expect(createHash("sha256").update(raw, "utf8").digest("hex")).toBe(
      EVAL_RUN_COMPARE_PARITY_SHA256,
    );
  });

  it("is the copy the backend fixture names as its mirror", () => {
    expect(fixture.__meta.mirror).toBe(
      "mcpjam-inspector/server/routes/v1/__fixtures__/eval-run-compare-parity.json",
    );
  });
});

describe("toRunCompareDto — leak gate", () => {
  it("drops traceBlobIds and every _storage id", () => {
    const serialized = JSON.stringify(dto());

    // The fixture's internal diff genuinely carries these — the backend's
    // parity test asserts that — so this is not passing vacuously.
    const internal = JSON.stringify(fixture.expectedDiff);
    expect(internal).toContain("traceBlobIds");
    expect(internal).toContain("kg27hn0wzy4t9xq3bd6vfmr5c81storage");
    expect(internal).toContain("kg9042pxwq7mn3jrl6svbt85dz1storage");

    expect(serialized).not.toContain("traceBlobIds");
    expect(serialized).not.toContain("kg27hn0wzy4t9xq3bd6vfmr5c81storage");
    expect(serialized).not.toContain("kg9042pxwq7mn3jrl6svbt85dz1storage");
    // Nothing that even looks like a storage handle.
    expect(serialized).not.toMatch(/storage/i);
  });

  it("projects the skills section, including the version move", () => {
    // The attribution half of a comparison: the fixture's `refunds` was edited
    // between the two runs, an MCP-served skill was added, and one was
    // untouched. A public caller needs all three to explain a regression.
    const skills = dto().skills as Record<string, any>;
    expect(skills.unchangedCount).toBe(1);
    expect(skills.base).toEqual({ excluded: false, count: 2 });

    const changed = skills.changes.find((c: any) => c.kind === "changed");
    expect(changed.name).toBe("refunds");
    expect(changed.versionDelta).toBe("v3 → v4");
    expect(changed.base.versionNumber).toBe(3);
    expect(changed.compare.versionNumber).toBe(4);

    const added = skills.changes.find((c: any) => c.kind === "added");
    expect(added.name).toBe("lookup");
    expect(added.channels).toEqual(["mcp-server"]);
  });

  it("passes a null skills section through instead of flattening it", () => {
    // null means "neither run recorded skills". An empty `{changes: []}` would
    // claim no skills were involved, which is a different statement.
    const dtoWithout = toRunCompareDto(
      { ...fixture.expectedDiff, skills: null },
      BASELINE,
    );
    expect(dtoWithout.skills).toBeNull();
  });

  it("keeps iterationIds, which are already public", () => {
    const cases = dto().cases as Array<Record<string, any>>;
    const regressed = cases.find((row) => row.caseKey === "ck_regressed");
    expect(regressed?.base.iterationIds).toEqual(["iter_base_regressed"]);
    expect(regressed?.compare.representativeIterationId).toBe(
      "iter_compare_regressed",
    );
  });

  it("drops an unknown extra field rather than passing it through", () => {
    const tampered = {
      ...fixture.expectedDiff,
      internalOnlySecret: "leak-me",
      cases: (fixture.expectedDiff.cases as unknown[]).map((row) => ({
        ...(row as Record<string, unknown>),
        internalCaseField: "leak-me-too",
      })),
    };
    const serialized = JSON.stringify(toRunCompareDto(tampered, BASELINE));
    // A whitelist, not a delete-list: a NEW internal field must be absent by
    // default, so the next `traceBlobIds` fails a test on the day it is added
    // rather than shipping publicly.
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("internalOnlySecret");
    expect(serialized).not.toContain("internalCaseField");
  });
});

describe("toRunCompareDto — projection", () => {
  it("renames the run-summary counters to passSummary", () => {
    const projected = dto() as Record<string, any>;
    // "scores" must not appear at the top level of the compare wire: the
    // internal field of that name is counters, not score-contract data.
    expect(projected).not.toHaveProperty("scores");
    expect(projected.passSummary.passRatePercent).toEqual({
      base: 100,
      compare: 66.66666666666666,
      delta: -33.33333333333334,
      percentDelta: -33.33333333333334,
    });
  });

  it("projects the score contract literally", () => {
    expect((dto() as Record<string, any>).scoreContract).toEqual({
      base: {
        evaluationConfigHash: "cfg_hash_base",
        scoreIntegrity: "valid",
        scoredIterations: 3,
        quarantinedIterations: 0,
      },
      compare: {
        evaluationConfigHash: "cfg_hash_compare",
        scoreIntegrity: "valid",
        scoredIterations: 3,
        quarantinedIterations: 1,
      },
      evaluationConfigChanged: true,
      scorers: [
        {
          scorerId: "tone",
          gating: false,
          deterministic: false,
          definitionChanged: false,
          passRate: { base: 1, compare: 1, delta: 0, percentDelta: 0 },
          meanValue: {
            base: 0.9,
            compare: 0.7,
            delta: -0.20000000000000007,
            percentDelta: -22.22222222222223,
          },
          errorCount: { base: 0, compare: 0 },
        },
        {
          scorerId: "tool-match",
          gating: true,
          deterministic: true,
          // Same id, different implementation hash. A consumer must NOT count
          // this flip as a regression — the two sides did not measure alike.
          definitionChanged: true,
          passRate: { base: 1, compare: 0.5, delta: -0.5, percentDelta: -50 },
          meanValue: { base: 1, compare: 0.5, delta: -0.5, percentDelta: -50 },
          errorCount: { base: 0, compare: 0 },
        },
      ],
    });
  });

  it("projects a case's status, config signals and score deltas literally", () => {
    const cases = (dto() as Record<string, any>).cases as Array<
      Record<string, any>
    >;
    const regressed = cases.find((row) => row.caseKey === "ck_regressed");

    expect(regressed).toEqual({
      caseKey: "ck_regressed",
      title: "Regressed case",
      status: "regressed",
      configChanged: false,
      evaluationConfigChanged: true,
      scoreDeltas: [
        {
          scorerId: "tone",
          gating: false,
          deterministic: false,
          definitionChanged: false,
          base: { status: "scored", value: 0.9, passed: true },
          compare: { status: "scored", value: 0.7, passed: true },
          value: {
            base: 0.9,
            compare: 0.7,
            delta: -0.20000000000000007,
            percentDelta: -22.22222222222223,
          },
        },
        {
          scorerId: "tool-match",
          gating: true,
          deterministic: true,
          definitionChanged: true,
          base: { status: "scored", value: 1, passed: true },
          compare: { status: "scored", value: 0, passed: false },
          value: { base: 1, compare: 0, delta: -1, percentDelta: -100 },
        },
      ],
      base: {
        outcome: "passed",
        iterationIds: ["iter_base_regressed"],
        representativeIterationId: "iter_base_regressed",
        error: null,
      },
      compare: {
        outcome: "failed",
        iterationIds: ["iter_compare_regressed"],
        representativeIterationId: "iter_compare_regressed",
        error: 'expected tool "search" was never called',
      },
    });
  });

  it("carries the baseline the ACTION resolved, not one the diff invented", () => {
    // The diff was handed two runs; only the action knows which policy chose
    // one of them, so `baseline` is passed in rather than read off the diff.
    expect(
      (
        toRunCompareDto(fixture.expectedDiff, {
          policy: "run",
          baseRunId: "run_explicit",
        }) as Record<string, any>
      ).baseline,
    ).toEqual({ policy: "run", baseRunId: "run_explicit" });
  });

  it("survives a malformed diff without throwing", () => {
    // The transport is `as any`; a backend that returns something unexpected
    // must produce an empty-but-valid DTO, not a 500.
    const projected = toRunCompareDto(null, BASELINE) as Record<string, any>;
    expect(projected.cases).toEqual([]);
    expect(projected.scoreContract.scorers).toEqual([]);
    expect(projected.baseline).toEqual(BASELINE);
  });
});

describe("baseline_not_found", () => {
  it("pins the union value the route maps to 404 + details.reason", () => {
    expect(fixture.expectedBaselineNotFound).toEqual({
      status: "baseline_not_found",
      policy: { kind: "previous_completed" },
    });
  });
});

describe("guest access", () => {
  /**
   * The compare route stays DEFAULT-DENIED for guests, and this pins it.
   *
   * `guest-allowed-paths.ts` is deliberately untouched by this change. The
   * sibling eval-run reads ARE guest-allowed, so "it looks like its
   * neighbours" is exactly the reasoning that would add it by reflex — but a
   * comparison reads TWO runs, one of which the caller never named, and
   * baseline resolution walks the suite's run history. Widening that to
   * anonymous callers is a decision worth making on purpose, not as a
   * side-effect of adding an endpoint.
   */
  it("is denied for guests while its siblings stay allowed", async () => {
    const { isGuestAllowedV1Request } = await import(
      "../guest-allowed-paths.js"
    );
    expect(
      isGuestAllowedV1Request(
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1/compare",
      ),
    ).toBe(false);
    // The siblings are unchanged — this is a targeted denial, not a
    // regression in the allowlist.
    expect(
      isGuestAllowedV1Request("GET", "/api/v1/projects/p1/eval-runs/run_1"),
    ).toBe(true);
    expect(
      isGuestAllowedV1Request(
        "GET",
        "/api/v1/projects/p1/eval-runs/run_1/iterations",
      ),
    ).toBe(true);
  });
});

describe("toRunCompareDto — the narrowing nobody else asserts", () => {
  it("keeps exactly three metrics, dropping the wider internal set", () => {
    // The internal diff carries startOffsetMs, inputTokens, outputTokens,
    // cachedInputTokens and reasoningTokens too. Nothing else fails if that
    // narrowing silently widens.
    const projected = dto() as Record<string, any>;
    expect(Object.keys(projected.metrics).sort()).toEqual([
      "estimatedCostUsd",
      "totalTokens",
      "wallDurationMs",
    ]);
    expect(projected.metrics.wallDurationMs).toEqual({
      base: 3000,
      compare: 6000,
      delta: 3000,
      percentDelta: 100,
    });
  });

  it("projects both run sides literally", () => {
    const projected = dto() as Record<string, any>;
    expect(projected.baseRun).toEqual({
      id: "run_parity_base",
      runNumber: 1,
      result: "passed",
      createdAt: 1000,
      completedAt: 4000,
      summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
    });
    expect(projected.compareRun.id).toBe("run_parity_compare");
    expect(projected.compareRun.result).toBe("failed");
  });
});
