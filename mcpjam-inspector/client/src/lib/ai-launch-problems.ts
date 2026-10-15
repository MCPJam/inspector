/**
 * The backend's launch refusal while an organization requires its own
 * provider keys: eval launches (`testSuites:startTestSuiteRun`, quick runs)
 * and swarm launches (`journeyRuns:createJourneyRun*`) throw one error with
 * `{ code, message, problems }`, listing EVERY required dependency that
 * cannot run on the organization's providers, so a person fixes them in one
 * pass instead of one launch at a time.
 *
 * Each problem's `reason` is the backend's own sentence. A dependency that
 * can't run on organization keys at all yet (the simulated user) arrives as
 * `org_runtime_unsupported`, whose reason names no fix. A harness runtime
 * (Claude Code, Codex) runs on an organization connection to its own vendor,
 * so it is a problem only when the selection isn't one: another vendor, an
 * MCPJam-provided or personal model, or a connection the harness can't use
 * (a custom base URL, a local runtime).
 */
import { isOrgKeyPolicyRefusalCode } from "@/shared/ai-execution-refusal";
import {
  describeOrgKeysRefusal,
  orgKeysRefusalCodeOf,
  type AiRefusalAudience,
} from "@/lib/org-keys-refusal";

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

const DEPENDENCY_TITLE: Readonly<Record<AiLaunchProblemDependency, string>> = {
  target: "Model",
  judge: "Judge",
  persona: "Simulated user",
  runtime: "Runtime",
};

function isKnownDependency(
  dependency: string,
): dependency is AiLaunchProblemDependency {
  return Object.prototype.hasOwnProperty.call(DEPENDENCY_TITLE, dependency);
}

/** The short heading for a problem's dependency ("Model", "Judge", …). */
export function aiLaunchDependencyTitle(dependency: string): string {
  return isKnownDependency(dependency)
    ? DEPENDENCY_TITLE[dependency]
    : "Dependency";
}

/**
 * The line above the list of problems a launch was refused for. Each item
 * names its own fix, so the line says only what to do with them.
 */
export const AI_LAUNCH_REFUSED_HEADLINE =
  "This run can't start yet. Fix the items below, then start it again.";

/** The same refusal as one paragraph, where the items follow inline. */
const AI_LAUNCH_REFUSED_LEAD =
  "This run can't start yet. Fix the following, then start it again.";

function readProblems(value: unknown): AiLaunchProblem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const problems: AiLaunchProblem[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (!reason) continue;
    problems.push({
      // A row without a dependency reads under the generic "Dependency"
      // heading, never as a model to change.
      dependency: typeof row.dependency === "string" ? row.dependency : "",
      label: typeof row.label === "string" ? row.label : "",
      code: typeof row.code === "string" ? row.code : "",
      reason,
    });
  }
  return problems.length > 0 ? problems : undefined;
}

/**
 * The first thing `read` finds on an error or where the transports nest it:
 * a ConvexError's `data`, an HTTP body (top level or under `details` /
 * `body`), or either of those serialized as JSON in `data` or `message`.
 */
function readErrorShapes<T>(
  error: unknown,
  nestedKeys: readonly string[],
  read: (record: Record<string, unknown>) => T | undefined,
): T | undefined {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): T | undefined => {
    if (!value || typeof value !== "object" || depth > 3 || seen.has(value))
      return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const direct = read(record);
    if (direct !== undefined) return direct;
    for (const key of nestedKeys) {
      const nested = visit(record[key], depth + 1);
      if (nested !== undefined) return nested;
    }
    // A ConvexError whose data arrived serialized.
    for (const key of ["data", "message"]) {
      const text = record[key];
      if (typeof text !== "string" || !text.trim().startsWith("{")) continue;
      try {
        const parsed = visit(JSON.parse(text), depth + 1);
        if (parsed !== undefined) return parsed;
      } catch {
        // Safe to ignore: text that only starts like JSON carries nothing to
        // read. Not logged itself, since it can hold a provider's message.
        console.debug("[ai-launch-problems] Error text is not JSON");
      }
    }
    return undefined;
  };
  return visit(error, 0);
}

/**
 * The `problems` a launch refusal carries, wherever the transport put them.
 * `[]` when the failure is not such a refusal.
 */
export function aiLaunchProblemsOf(error: unknown): AiLaunchProblem[] {
  return (
    readErrorShapes(
      error,
      ["data", "details", "body", "problems"],
      (record) => readProblems(record.problems) ?? readProblems(record),
    ) ?? []
  );
}

/**
 * The refusal's primary code (`org_keys_required`, …), when it is one, read
 * from the same shapes as its problems.
 */
export function aiLaunchRefusalCodeOf(error: unknown): string | undefined {
  return readErrorShapes(error, ["data", "details", "body"], (record) =>
    orgKeysRefusalCodeOf(record.code),
  );
}

/**
 * The whole refusal as one paragraph, for surfaces that show a launch error as
 * text: that the run can't start and what to do, then each dependency with
 * its reason.
 */
export function aiLaunchProblemsSentence(
  problems: readonly AiLaunchProblem[],
): string {
  return [
    AI_LAUNCH_REFUSED_LEAD,
    ...problems.map(
      (problem) =>
        `${aiLaunchDependencyTitle(problem.dependency)}: ${problem.reason}`,
    ),
  ].join(" ");
}

/**
 * What a launch the organization's AI key policy refused reads as, or
 * `undefined` for any other failure. With a problem list: the headline, with
 * the problems listed under it. Without one (a refusal that names only its
 * code): the shared copy for that code, so a feature that can't run on
 * organization keys yet reads as unavailable, never as a fix to make.
 */
export function aiLaunchRefusalOf(
  error: unknown,
  audience: AiRefusalAudience = "member",
): { message: string; problems: AiLaunchProblem[] } | undefined {
  const problems = aiLaunchProblemsOf(error);
  if (problems.length > 0) {
    return { message: AI_LAUNCH_REFUSED_HEADLINE, problems };
  }
  // Only the seven policy codes: a bare `credential_missing` predates the
  // policy, and its own message says more than the policy copy would.
  const code = aiLaunchRefusalCodeOf(error);
  if (!code || !isOrgKeyPolicyRefusalCode(code)) return undefined;
  return { message: describeOrgKeysRefusal(code, audience).body, problems: [] };
}

/**
 * {@link aiLaunchRefusalOf} as one paragraph, for surfaces that show a launch
 * error as text, or `undefined` for any other failure.
 */
export function aiLaunchRefusalSentence(error: unknown): string | undefined {
  const refusal = aiLaunchRefusalOf(error);
  if (!refusal) return undefined;
  return refusal.problems.length > 0
    ? aiLaunchProblemsSentence(refusal.problems)
    : refusal.message;
}
