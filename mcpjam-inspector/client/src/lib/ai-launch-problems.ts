/**
 * The backend's launch refusal while an organization requires its own
 * provider keys: eval launches (`testSuites:startTestSuiteRun`, quick runs)
 * and swarm launches (`journeyRuns:createJourneyRun*`) throw one error with
 * `{ code, message, problems }`, listing EVERY required dependency that
 * cannot run on the organization's providers, so a person fixes them in one
 * pass instead of one launch at a time.
 */
import { orgKeysRefusalCodeOf } from "@/lib/org-keys-refusal";

export type AiLaunchProblemDependency =
  "target" | "judge" | "persona" | "runtime";

export type AiLaunchProblem = {
  dependency: AiLaunchProblemDependency | (string & {});
  /** What the person sees: a model id, a case or host label, "The judge". */
  label: string;
  code: string;
  /** A full sentence from the backend. */
  reason: string;
};

const DEPENDENCY_TITLE: Record<string, string> = {
  target: "Model",
  judge: "Judge",
  persona: "Simulated user",
  runtime: "Runtime",
};

/** The short heading for a problem's dependency ("Model", "Judge", …). */
export function aiLaunchDependencyTitle(dependency: string): string {
  return DEPENDENCY_TITLE[dependency] ?? "Dependency";
}

function readProblems(value: unknown): AiLaunchProblem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const problems: AiLaunchProblem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!reason) continue;
    problems.push({
      dependency:
        typeof row.dependency === "string" ? row.dependency : "target",
      label: typeof row.label === "string" ? row.label : "",
      code: typeof row.code === "string" ? row.code : "",
      reason,
    });
  }
  return problems.length > 0 ? problems : undefined;
}

/**
 * The `problems` a launch refusal carries, wherever the transport put them:
 * a ConvexError's `data`, an HTTP body (top level or under `details`), or an
 * error object holding either. `[]` when the failure is not such a refusal.
 */
export function aiLaunchProblemsOf(error: unknown): AiLaunchProblem[] {
  const seen = new Set<unknown>();
  const visit = (
    value: unknown,
    depth: number,
  ): AiLaunchProblem[] | undefined => {
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value))
      return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const direct = readProblems(record.problems) ?? readProblems(value);
    if (direct) return direct;
    for (const key of ["data", "details", "body", "problems"]) {
      const nested = visit(record[key], depth + 1);
      if (nested) return nested;
    }
    // A ConvexError whose data arrived serialized.
    for (const key of ["data", "message"]) {
      const text = record[key];
      if (typeof text !== "string" || !text.trim().startsWith("{")) continue;
      try {
        const parsed = visit(JSON.parse(text), depth + 1);
        if (parsed) return parsed;
      } catch {
        // Not JSON.
      }
    }
    return undefined;
  };
  return visit(error, 0) ?? [];
}

/** The refusal's primary code (`org_keys_required`, …), when it is one. */
export function aiLaunchRefusalCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const candidate of [
    record.code,
    (record.data as Record<string, unknown> | undefined)?.code,
    (record.details as Record<string, unknown> | undefined)?.code,
  ]) {
    const code = orgKeysRefusalCodeOf(candidate);
    if (code) return code;
  }
  return undefined;
}

/**
 * The whole refusal as one paragraph, for surfaces that show a launch error as
 * text: the policy, then each dependency with its reason.
 */
export function aiLaunchProblemsSentence(
  problems: readonly AiLaunchProblem[],
): string {
  return [
    "This organization requires its own provider keys for AI features, and this run has dependencies that can't run on them.",
    ...problems.map(
      (problem) =>
        `${aiLaunchDependencyTitle(problem.dependency)}: ${problem.reason}`,
    ),
  ].join(" ");
}
