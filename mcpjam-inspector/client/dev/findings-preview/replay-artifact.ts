/**
 * The replay artifact's client-side shape, and its validator.
 *
 * MIRRORED from `convex/lib/evalFindingsReplay.ts` in the backend repo, which
 * is the producer. The two repos cannot import from each other, so parity is
 * kept the way this codebase keeps every other cross-repo contract: a FIXTURE
 * both sides check, not matching TypeScript names. See
 * `client/src/components/shared/actionable-insights/__tests__/replay-artifact-parity.test.ts`.
 *
 * Validated before use, not trusted: the file is whatever a person pointed
 * `--replay` at, and a preview that half-renders a malformed artifact would
 * be showing findings about a population nobody can name.
 */
import type {
  ActionableFinding,
  InsightsFindingProvenance,
  InsightsObservationState,
  UnifiedFindingsExperiment,
} from "@/lib/insights-envelope-api";

export const REPLAY_ARTIFACT_VERSION = 1;
export const REPLAY_ARTIFACT_KIND = "unified_findings_replay";

export type ReplayIteration = {
  iterationId: string;
  caseKey: string | null;
  title: string | null;
  status: string;
  result: string;
  stageLines: string[];
  judgeLines: string[];
  errorExcerpt: string | null;
};

export type ReplayCase = {
  label: string;
  note: string | null;
  inputSource: "synthetic" | "recorded";
  run: {
    runId: string;
    suiteId: string;
    suiteName: string | null;
    runStatus: string;
  };
  observationState: InsightsObservationState;
  coverage: {
    unit: "iterations";
    analyzed: number;
    total: number;
    gradedCount: number;
    exclusions: Record<string, number>;
  };
  omittedGroups: number;
  snapshotBytes: number;
  deterministicFindings: ActionableFinding[];
  enrichedFindings: ActionableFinding[] | null;
  enrichment: {
    source: "mocked" | "real";
    modelUsed: string;
    summary: string;
    acceptedCount: number;
    rejectedCount: number;
    rejectedIds: string[];
  } | null;
  baseline: NonNullable<UnifiedFindingsExperiment["snapshot"]>["baseline"];
  provenance: InsightsFindingProvenance[];
  proseOrigins: Record<
    string,
    {
      title: string;
      rootCause: string;
      recommendation: string;
      acceptanceCriteria: string;
    }
  >;
  trim: { droppedEvidence: number; droppedCandidates: number } | null;
  iterations: ReplayIteration[];
};

export type ReplayArtifact = {
  artifactVersion: number;
  kind: typeof REPLAY_ARTIFACT_KIND;
  generatedAt: number;
  minerVersion: number;
  snapshotVersion: number;
  producedBy: string;
  cases: ReplayCase[];
};

export class ReplayArtifactError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseReplayArtifact(raw: unknown): ReplayArtifact {
  if (!isRecord(raw)) {
    throw new ReplayArtifactError("the artifact's top level is not an object");
  }
  if (raw.kind !== REPLAY_ARTIFACT_KIND) {
    throw new ReplayArtifactError(
      `this file is not a unified-findings replay artifact (kind: ${String(raw.kind)})`,
    );
  }
  if (raw.artifactVersion !== REPLAY_ARTIFACT_VERSION) {
    throw new ReplayArtifactError(
      `artifactVersion ${String(raw.artifactVersion)} is not supported (this preview reads ${REPLAY_ARTIFACT_VERSION}). Re-run npm run findings:replay from the paired backend checkout.`,
    );
  }
  if (!Array.isArray(raw.cases)) {
    throw new ReplayArtifactError("the artifact carries no `cases` array");
  }
  for (const [index, item] of raw.cases.entries()) {
    if (!isRecord(item)) {
      throw new ReplayArtifactError(`case ${index} is not an object`);
    }
    for (const field of [
      "label",
      "observationState",
      "coverage",
      "deterministicFindings",
      "provenance",
      "iterations",
    ]) {
      if (item[field] === undefined) {
        throw new ReplayArtifactError(
          `case ${index} ("${String(item.label)}") is missing "${field}"`,
        );
      }
    }
  }
  return raw as unknown as ReplayArtifact;
}

/**
 * The experiment payload a replay case denotes.
 *
 * Built here rather than shipped in the artifact so the preview exercises the
 * SAME prop shape the live envelope produces — if the panel starts needing a
 * field, this function stops compiling, which is the point.
 */
export function experimentFor(
  replayCase: ReplayCase,
  generatedAt: number,
): UnifiedFindingsExperiment {
  return {
    capability: "unified_findings_v1",
    snapshot: {
      builtAt: generatedAt,
      sourceRevision: `replay:${replayCase.label}`,
      minerVersion: 1,
      omittedGroups: replayCase.omittedGroups,
      deterministicFindings: replayCase.deterministicFindings,
      provenance: replayCase.provenance,
      ...(replayCase.trim ? { trim: replayCase.trim } : {}),
      enrichment: replayCase.enrichment
        ? {
            status: "ready",
            generatedAt,
            modelUsed: replayCase.enrichment.modelUsed,
            summary: replayCase.enrichment.summary,
            acceptedCount: replayCase.enrichment.acceptedCount,
            rejectedCount: replayCase.enrichment.rejectedCount,
          }
        : null,
      baseline: replayCase.baseline,
    },
    job: null,
    canBuild: true,
    canEnrich: true,
    writesEnabled: false,
  };
}

/**
 * Provenance for the AI view, with the producer's per-field origins attached.
 *
 * The artifact keeps origins in their own map because the deterministic view's
 * answer is fixed by construction; only the AI view needs them.
 */
export function provenanceForView(
  replayCase: ReplayCase,
  view: "deterministic" | "ai",
): InsightsFindingProvenance[] {
  if (view === "deterministic") return replayCase.provenance;
  return replayCase.provenance.map((row) => {
    const origin = replayCase.proseOrigins[row.candidateId];
    return origin
      ? {
          ...row,
          proseOrigin:
            origin as NonNullable<InsightsFindingProvenance["proseOrigin"]>,
        }
      : row;
  });
}
