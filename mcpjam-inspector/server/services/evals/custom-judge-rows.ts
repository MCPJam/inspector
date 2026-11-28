/**
 * Custom judges (evaluator library slice 3) as score rows.
 *
 * The goal-completion job stamps `metadata.customJudgesVerdict` with one
 * entry per judge; the judge second pass projects each into an ADVISORY
 * `judge:custom:<id>` row beside the goal judge's own. Kept out of
 * `score-rows.ts` so that file does not grow past its size limit.
 */
import {
  canonicalDigest,
  errorScoreResult,
  finalizeScoreResult,
  type ResolvedScoreDefinition,
  type ScoreDefinition,
  type ScoreResult,
} from "@mcpjam/sdk/contract";
import { HOSTED_CUSTOM_JUDGE_SCORER_PREFIX } from "@/shared/hosted-criterion-id";

/** Version of this projection (NOT the backend's prompt wrapper). */
const HOSTED_CUSTOM_JUDGES_PROJECTION_VERSION = "1";

/** Everything `unknown`: it arrives from a database document. */
export type HostedCustomJudgesVerdictLike = {
  status?: unknown;
  templateVersion?: unknown;
  model?: unknown;
  judges?: unknown;
};

export type HostedCustomJudgeDefinitionInput = {
  id: string;
  label: string;
  /** Digest of the prompt, output format and wrapper, from the backend. */
  contentDigest: string;
  passThreshold: number;
  templateVersion?: number;
  model?: string;
};

type StoredCustomJudge = HostedCustomJudgeDefinitionInput & {
  status: "scored" | "error";
  value?: number;
  reason?: string;
  error?: string;
};

function hostedCustomJudgeScorerId(id: string): string {
  return `${HOSTED_CUSTOM_JUDGE_SCORER_PREFIX}${id}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A pass/fail judge scores 1 or 0, so it passes at any line above 0. */
function passThresholdOf(output: unknown): number | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as { kind?: unknown; threshold?: unknown };
  if (o.kind === "passfail") return 0.5;
  if (o.kind === "score" && isFiniteNumber(o.threshold)) return o.threshold;
  return undefined;
}

/**
 * The judges a stored verdict can be projected from. One missing its id,
 * digest or output format is dropped rather than guessed at: there would be
 * no definition to resolve its row against.
 */
function customJudgesFrom(
  verdict: HostedCustomJudgesVerdictLike | undefined,
): StoredCustomJudge[] {
  if (!verdict || !Array.isArray(verdict.judges)) return [];
  const templateVersion = isFiniteNumber(verdict.templateVersion)
    ? verdict.templateVersion
    : undefined;
  const model =
    typeof verdict.model === "string" && verdict.model.length > 0
      ? verdict.model
      : undefined;
  const seen = new Set<string>();
  const out: StoredCustomJudge[] = [];
  for (const raw of verdict.judges) {
    if (typeof raw !== "object" || raw === null) continue;
    const j = raw as Record<string, unknown>;
    const passThreshold = passThresholdOf(j.output);
    if (
      typeof j.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(j.id) ||
      seen.has(j.id) ||
      typeof j.contentDigest !== "string" ||
      j.contentDigest.length === 0 ||
      passThreshold === undefined
    ) {
      continue;
    }
    seen.add(j.id);
    out.push({
      id: j.id,
      label: typeof j.label === "string" ? j.label : j.id,
      contentDigest: j.contentDigest,
      passThreshold,
      ...(templateVersion !== undefined ? { templateVersion } : {}),
      ...(model ? { model } : {}),
      status: j.status === "scored" ? "scored" : "error",
      ...(isFiniteNumber(j.value) ? { value: j.value } : {}),
      ...(typeof j.reason === "string" ? { reason: j.reason } : {}),
      ...(typeof j.error === "string" ? { error: j.error } : {}),
    });
  }
  return out;
}

/**
 * `judge:custom:<id>`: non-deterministic and ALWAYS advisory. The hash covers
 * the backend's content digest (prompt, format, threshold, wrapper), so
 * editing the prompt starts a new history and renaming the judge does not.
 */
export function hostedCustomJudgeScoreDefinition(
  args: HostedCustomJudgeDefinitionInput,
): ScoreDefinition {
  return {
    scorerId: hostedCustomJudgeScorerId(args.id),
    idSource: "platform",
    scorerVersion: HOSTED_CUSTOM_JUDGES_PROJECTION_VERSION,
    implementationHash: canonicalDigest({
      contentDigest: args.contentDigest,
      templateVersion: args.templateVersion ?? null,
    }),
    label: `custom judge: ${args.label}`,
    deterministic: false,
    passThreshold: args.passThreshold,
    role: "advisory",
    ...(args.model ? { model: args.model } : {}),
  };
}

/** Definition inputs for the config snapshot, from the same verdict as the rows. */
export function customJudgeDefinitionInputs(
  verdict: HostedCustomJudgesVerdictLike | undefined,
): HostedCustomJudgeDefinitionInput[] {
  return customJudgesFrom(verdict).map((judge) => ({
    id: judge.id,
    label: judge.label,
    contentDigest: judge.contentDigest,
    passThreshold: judge.passThreshold,
    ...(judge.templateVersion !== undefined
      ? { templateVersion: judge.templateVersion }
      : {}),
    ...(judge.model ? { model: judge.model } : {}),
  }));
}

/** One row per judge. No answer is an error row, never a zero. */
export function customJudgeScoreRows(
  verdict: HostedCustomJudgesVerdictLike | undefined,
  byId: ReadonlyMap<string, ResolvedScoreDefinition>,
): ScoreResult[] {
  const rows: ScoreResult[] = [];
  for (const judge of customJudgesFrom(verdict)) {
    const definition = byId.get(hostedCustomJudgeScorerId(judge.id));
    if (!definition) continue;
    if (judge.status === "error" || judge.value === undefined) {
      rows.push(
        errorScoreResult(
          definition,
          [judge.error ?? "no_answer", judge.reason].filter(Boolean).join(": "),
        ),
      );
      continue;
    }
    rows.push(
      finalizeScoreResult(definition, {
        kind: "scored",
        value: judge.value,
        ...(judge.reason ? { rationale: judge.reason } : {}),
      }),
    );
  }
  return rows;
}
