/**
 * Reads the questions off a stored `metadata.rubricChecksVerdict`.
 *
 * The server projects score rows from these questions. The trial scorecard
 * reads the same verdict only to tell which projected rows are yes/no answers
 * and what P(yes) each got, so both sides parse it with this one function.
 */

export type RubricCheckVerdictQuestion = {
  /** `c:<criterionId>` for a suite criterion, `q:<questionId>` if authored. */
  key: string;
  kind: "boolean" | "choice" | "score";
  label: string;
  contentDigest: string;
  passThreshold: number;
  templateVersion?: number;
  templateHash?: string;
  status: "scored" | "error" | "skipped";
  value?: number;
  probability?: number;
  error?: string;
  rationale?: string;
  evidence?: string[];
};

const RUBRIC_CHECK_KINDS = new Set(["boolean", "choice", "score"]);
const QUESTION_KEY = /^[cq]:[A-Za-z0-9_-]{1,64}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRubricCheckKind(
  value: unknown,
): value is RubricCheckVerdictQuestion["kind"] {
  return typeof value === "string" && RUBRIC_CHECK_KINDS.has(value);
}

/**
 * A question missing its key, kind, digest or pass line is DROPPED, not
 * guessed at: without those there is no definition to resolve a row against.
 * An unknown status is kept as an error, so it cannot vanish silently.
 */
export function rubricCheckVerdictQuestions(
  verdict: unknown,
): RubricCheckVerdictQuestion[] {
  if (typeof verdict !== "object" || verdict === null) return [];
  const { questions, templateVersion, templateHash } = verdict as Record<
    string,
    unknown
  >;
  if (!Array.isArray(questions)) return [];
  const seen = new Set<string>();
  const out: RubricCheckVerdictQuestion[] = [];
  for (const raw of questions) {
    if (typeof raw !== "object" || raw === null) continue;
    const q = raw as Record<string, unknown>;
    if (
      typeof q.key !== "string" ||
      !QUESTION_KEY.test(q.key) ||
      seen.has(q.key) ||
      !isRubricCheckKind(q.kind) ||
      typeof q.contentDigest !== "string" ||
      q.contentDigest.length === 0 ||
      !isFiniteNumber(q.passThreshold)
    ) {
      continue;
    }
    seen.add(q.key);
    const status =
      q.status === "scored" || q.status === "skipped" ? q.status : "error";
    out.push({
      key: q.key,
      kind: q.kind,
      label: typeof q.label === "string" && q.label ? q.label : q.key,
      contentDigest: q.contentDigest,
      passThreshold: q.passThreshold,
      ...(isFiniteNumber(templateVersion) ? { templateVersion } : {}),
      ...(typeof templateHash === "string" ? { templateHash } : {}),
      status,
      ...(isFiniteNumber(q.value) ? { value: q.value } : {}),
      ...(isFiniteNumber(q.probability) ? { probability: q.probability } : {}),
      ...(typeof q.error === "string"
        ? { error: q.error }
        : q.status !== status
          ? { error: `unknown status ${JSON.stringify(q.status)}` }
          : {}),
      ...(typeof q.rationale === "string" ? { rationale: q.rationale } : {}),
      ...(Array.isArray(q.evidence)
        ? {
            evidence: q.evidence.filter(
              (entry): entry is string => typeof entry === "string",
            ),
          }
        : {}),
    });
  }
  return out;
}
