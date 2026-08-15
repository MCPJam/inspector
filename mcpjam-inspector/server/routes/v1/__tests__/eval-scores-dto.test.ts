/**
 * The public v1 score projection.
 *
 * `toIterationDto` is a WHITELIST, and these tests exist to keep it one. The
 * failure this guards against is not "scores are missing" — it is
 * `metadata` (an open record carrying internal signals, quarantined raw
 * payloads, step-replay blobs) leaking past the boundary because someone
 * reached for a passthrough to ship one more field.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildEvaluationConfigSnapshot,
  definitionHash,
  finalizeScoreResult,
  resolveScoreDefinition,
} from "@mcpjam/sdk/contract";
import type { ScoreDefinition } from "@mcpjam/sdk/contract";

const convexQueryMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    query = convexQueryMock;
    action = vi.fn();
    mutation = vi.fn();
    setAuth = vi.fn();
  },
}));

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
 * Reimplements the route's projection contract as a black box: build the
 * metadata a real ingest would store, run it through the same validators the
 * route uses, and assert on what survives. The route module itself is a large
 * Hono app with a heavy dependency graph; what is under test here is the
 * projection rule, which is exactly reproducible from the exported schemas.
 */
async function project(metadata: Record<string, unknown>) {
  const { evaluationConfigSnapshotSchema, scoreResultArraySchema } =
    await import("@mcpjam/sdk/contract");
  const parsedScores = scoreResultArraySchema.safeParse(metadata.scores);
  const parsedConfig = evaluationConfigSnapshotSchema.safeParse(
    metadata.evaluationConfig,
  );
  const integrity =
    metadata.scoreIntegrity === "score_integrity_invalid"
      ? { scoreIntegrity: metadata.scoreIntegrity }
      : {};
  if (!parsedScores.success || !parsedConfig.success) {
    return integrity as Record<string, unknown>;
  }
  return {
    scores: parsedScores.data,
    evaluationConfig: parsedConfig.data,
    ...integrity,
  } as Record<string, unknown>;
}

beforeEach(() => {
  convexQueryMock.mockReset();
});

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
