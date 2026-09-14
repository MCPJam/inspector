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
      `this file is not a unified-findings replay artifact (kind: ${String(
        raw.kind,
      )})`,
    );
  }
  if (raw.artifactVersion !== REPLAY_ARTIFACT_VERSION) {
    throw new ReplayArtifactError(
      `artifactVersion ${String(
        raw.artifactVersion,
      )} is not supported (this preview reads ${REPLAY_ARTIFACT_VERSION}). Re-run npm run findings:replay from the paired backend checkout.`,
    );
  }
  if (!Array.isArray(raw.cases)) {
    throw new ReplayArtifactError("the artifact carries no `cases` array");
  }
  for (const [index, item] of raw.cases.entries()) {
    validateCase(index, item);
  }
  return raw as unknown as ReplayArtifact;
}

/**
 * Everything the panel DEREFERENCES on a case, checked before it can.
 *
 * Presence alone is not enough: `coverage: { exclusions: null }` satisfies a
 * `!== undefined` check and then throws a TypeError out of `Object.entries`
 * deep inside the render, which is a crash where this file's whole job is to
 * produce a named `ReplayArtifactError` the preview can show.
 */
function validateCase(index: number, item: unknown): void {
  const where = (field: string) =>
    `case ${index}${
      isRecord(item) && typeof item.label === "string"
        ? ` ("${item.label}")`
        : ""
    }: ${field}`;

  if (!isRecord(item)) {
    throw new ReplayArtifactError(`case ${index} is not an object`);
  }
  if (typeof item.label !== "string") {
    throw new ReplayArtifactError(`${where("label")} is not a string`);
  }
  if (typeof item.observationState !== "string") {
    throw new ReplayArtifactError(
      `${where("observationState")} is not a string`,
    );
  }
  if (typeof item.omittedGroups !== "number") {
    throw new ReplayArtifactError(`${where("omittedGroups")} is not a number`);
  }

  if (!isRecord(item.coverage)) {
    throw new ReplayArtifactError(`${where("coverage")} is not an object`);
  }
  for (const field of ["analyzed", "total", "gradedCount"]) {
    if (typeof item.coverage[field] !== "number") {
      throw new ReplayArtifactError(
        `${where(`coverage.${field}`)} is not a number`,
      );
    }
  }
  if (!isRecord(item.coverage.exclusions)) {
    throw new ReplayArtifactError(
      `${where("coverage.exclusions")} is not an object`,
    );
  }
  for (const [reason, count] of Object.entries(item.coverage.exclusions)) {
    if (typeof count !== "number") {
      throw new ReplayArtifactError(
        `${where(`coverage.exclusions.${reason}`)} is not a number`,
      );
    }
  }

  for (const field of [
    "deterministicFindings",
    "provenance",
    "iterations",
  ] as const) {
    if (!Array.isArray(item[field])) {
      throw new ReplayArtifactError(`${where(field)} is not an array`);
    }
  }
  if (
    item.enrichedFindings !== null &&
    item.enrichedFindings !== undefined &&
    !Array.isArray(item.enrichedFindings)
  ) {
    throw new ReplayArtifactError(
      `${where("enrichedFindings")} is neither null nor an array`,
    );
  }

  const provenance = item.provenance;
  if (!Array.isArray(provenance)) {
    throw new ReplayArtifactError(`${where("provenance")} is not an array`);
  }
  for (const row of provenance) {
    if (!isRecord(row)) {
      throw new ReplayArtifactError(
        `${where("provenance")} holds a non-object row`,
      );
    }
    const judgeCoverage = row.judgeCoverage;
    if (judgeCoverage === undefined || judgeCoverage === null) continue;
    if (!isRecord(judgeCoverage) || !isRecord(judgeCoverage.nonGraded)) {
      throw new ReplayArtifactError(
        `${where("provenance[].judgeCoverage")} is missing its nonGraded counts`,
      );
    }
  }

  if (item.proseOrigins !== undefined && !isRecord(item.proseOrigins)) {
    throw new ReplayArtifactError(`${where("proseOrigins")} is not an object`);
  }
  if (item.trim !== null && item.trim !== undefined && !isRecord(item.trim)) {
    throw new ReplayArtifactError(
      `${where("trim")} is neither null nor an object`,
    );
  }
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
  /** The PRODUCER's miner version, off the artifact. Never a literal: this
   *  panel labels its own provenance, and inventing a version here would be
   *  the one kind of claim this experiment exists to refuse. */
  minerVersion: number,
): UnifiedFindingsExperiment {
  return {
    capability: "unified_findings_v1",
    snapshot: {
      builtAt: generatedAt,
      sourceRevision: `replay:${replayCase.label}`,
      minerVersion,
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
          proseOrigin: origin as NonNullable<
            InsightsFindingProvenance["proseOrigin"]
          >,
        }
      : row;
  });
}
