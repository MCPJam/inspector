/**
 * The public v1 score projection.
 *
 * `toIterationDto` is a WHITELIST, and these tests exist to keep it one. The
 * failure this guards against is not "scores are missing" — it is
 * `metadata` (an open record carrying internal signals, quarantined raw
 * payloads, step-replay blobs) leaking past the boundary because someone
 * reached for a passthrough to ship one more field.
 */

import { describe, expect, it } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  finalizeScoreResult,
  resolveScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { ScoreDefinition } from "@mcpjam/sdk/contract";

const GATING: ScoreDefinition = {
  scorerId: "refund-mentioned",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-refund",
  deterministic: true,
  passThreshold: 1,
  role: "gating",
};

const ADVISORY: ScoreDefinition = {
  scorerId: "tone",
  idSource: "explicit",
  scorerVersion: "1",
  implementationHash: "impl-tone",
  deterministic: false,
  passThreshold: 0.7,
  role: "advisory",
};

const snapshot = buildEvaluationConfigSnapshot([GATING, ADVISORY]);
const scores = [
  finalizeScoreResult(resolveScoreDefinition(GATING), {
    kind: "scored",
    value: 1,
    rationale: "found it",
  }),
  finalizeScoreResult(resolveScoreDefinition(ADVISORY), {
    kind: "scored",
    value: 0.4,
    rationale: "curt",
  }),
];

/**
 * Exercises the PRODUCTION projection, imported from the route's own module.
 * A test that re-implemented the rule would only prove it agrees with itself,
 * and the thing this boundary guards — `metadata` never leaking — is exactly
 * what such a test would stop noticing.
 */
async function project(metadata: Record<string, unknown>) {
  const { toScoreProjection } = await import("../eval-score-projection.js");
  return toScoreProjection(metadata) as Record<string, unknown>;
}

describe("iteration score projection", () => {
  it("projects scores and the snapshot together", async () => {
    const dto = await project({ scores, evaluationConfig: snapshot });
    expect(dto.scores).toHaveLength(2);
    expect(dto.evaluationConfig?.hash).toBe(snapshot.hash);
    // The join key is present on every row and resolves against the snapshot.
    for (const row of dto.scores ?? []) {
      expect(
        snapshot.definitions.some(
          (definition) => definitionHash(definition) === row.definitionHash,
        ),
      ).toBe(true);
    }
  });

  it("projects NEITHER half when the snapshot is missing", async () => {
    // Results alone are un-joinable: role and the error policies live on the
    // definitions, so a caller could not tell a gating failure from an
    // advisory one. Half the evidence is worse than none.
    const dto = await project({ scores });
    expect(dto.scores).toBeUndefined();
    expect(dto.evaluationConfig).toBeUndefined();
  });

  it("projects NEITHER half when any score row is malformed", async () => {
    const tampered = [
      { ...scores[0], passed: false }, // contradicts value >= passThreshold
      scores[1],
    ];
    const dto = await project({
      scores: tampered,
      evaluationConfig: snapshot,
    });
    expect(dto.scores).toBeUndefined();
  });

  it("still surfaces the integrity flag when the payload is unprojectable", async () => {
    // The flag is the ONLY thing that survives: an operator must be able to
    // tell "this run has no scores" from "this run's scores did not verify".
    const dto = await project({
      scores: [{ nonsense: true }],
      evaluationConfig: snapshot,
      scoreIntegrity: "score_integrity_invalid",
    });
    expect(dto.scores).toBeUndefined();
    expect(dto.scoreIntegrity).toBe("score_integrity_invalid");
  });

  it("projects NO evidence at all when integrity is invalid, even if valid", async () => {
    // The surviving rows are the subset that happened to validate. Publishing
    // them would let a consumer compute a clean pass from an incomplete
    // picture of a verdict the backend already downgraded.
    const dto = await project({
      scores,
      evaluationConfig: snapshot,
      scoreIntegrity: "score_integrity_invalid",
    });
    expect(dto.scores).toBeUndefined();
    expect(dto.evaluationConfig).toBeUndefined();
    expect(dto.scoreIntegrity).toBe("score_integrity_invalid");
  });

  it("ignores an unrecognized integrity marker", async () => {
    const dto = await project({
      scores,
      evaluationConfig: snapshot,
      scoreIntegrity: "probably_fine",
    });
    expect(dto.scoreIntegrity).toBeUndefined();
    // …and the evidence still projects, because nothing flagged it.
    expect(dto.scores).toHaveLength(2);
  });

  it("tolerates null and non-object metadata", async () => {
    expect(await project(null as unknown as Record<string, unknown>)).toEqual({});
    expect(
      await project("nope" as unknown as Record<string, unknown>),
    ).toEqual({});
    expect(await project({ scores: null, evaluationConfig: null })).toEqual({});
    expect(await project({ scores: [], evaluationConfig: snapshot })).toEqual({
      scores: [],
      evaluationConfig: snapshot,
    });
  });

  it("never projects metadata itself, or quarantined raw payloads", async () => {
    const dto = await project({
      scores,
      evaluationConfig: snapshot,
      // Everything below is internal and must not appear in the projection.
      scoresQuarantined: [{ reason: "malformed", raw: { secret: "leak-me" } }],
      stepResults: [{ stepId: "s1", passed: false }],
      compareRunId: "run_internal",
      "host.apiKey": "sk-should-never-leave",
    });

    expect(Object.keys(dto).sort()).toEqual([
      "evaluationConfig",
      "scores",
    ]);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("leak-me");
    expect(serialized).not.toContain("scoresQuarantined");
    expect(serialized).not.toContain("stepResults");
    expect(serialized).not.toContain("sk-should-never-leave");
  });

  it("is inert for runs that predate scoring", async () => {
    // Not `{scores: null, ...}` — NO KEYS AT ALL, so the DTO for the
    // overwhelming majority of iterations is byte-identical to before scores
    // existed.
    const dto = await project({ retryCount: 0, iterationNumber: 1 });
    expect(dto).toEqual({});
  });
});

describe("run-level integrity projection", () => {
  it("projects only the two known verdicts", async () => {
    const { toRunScoreIntegrity } = await import(
      "../eval-score-projection.js"
    );
    expect(toRunScoreIntegrity("valid")).toEqual({ scoreIntegrity: "valid" });
    expect(toRunScoreIntegrity("invalid")).toEqual({
      scoreIntegrity: "invalid",
    });
    // Absent means NO VERDICT, which a gate treats exactly like invalid.
    expect(toRunScoreIntegrity(undefined)).toEqual({});
    expect(toRunScoreIntegrity(null)).toEqual({});
    expect(toRunScoreIntegrity("probably_fine")).toEqual({});
  });
});

describe("guest access is unaffected by the new fields", () => {
  /**
   * Adding a field to an existing DTO must not change WHO may read it.
   *
   * These eval-run reads were ALREADY guest-allowed before scores existed —
   * they are part of the platform MCP catalog surface, and the same response
   * already carries tool-call arguments and raw error strings. The score rows
   * inherit exactly that posture; this pins it so a future edit here has to be
   * deliberate rather than incidental to a DTO change.
   */
  it("leaves the eval-run allowlist exactly as it was", async () => {
    const { isGuestAllowedV1Request } = await import(
      "../guest-allowed-paths.js"
    );
    // Reads: allowed before this change, allowed after.
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

  it("keeps unrelated surfaces guest-denied (default-deny holds)", async () => {
    const { isGuestAllowedV1Request } = await import(
      "../guest-allowed-paths.js"
    );
    expect(isGuestAllowedV1Request("GET", "/api/v1/me")).toBe(false);
    expect(
      isGuestAllowedV1Request("POST", "/api/v1/projects/p1/eval-suites"),
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "PATCH",
        "/api/v1/projects/p1/eval-suites/suite_1",
      ),
    ).toBe(false);
  });
});
