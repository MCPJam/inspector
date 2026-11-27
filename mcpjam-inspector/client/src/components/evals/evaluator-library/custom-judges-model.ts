import type { CustomJudge } from "@/components/shared/session-quality/judge-config";
import type { SuiteCapabilities } from "@/hooks/use-suite-capabilities";
import type { EvalJudgeConfig } from "../types";
import { usedVariables } from "./prompt-editor";
import type { PromptVariable } from "./variable-mapping-table";

const VARIABLE_DESCRIPTIONS = new Map([
  ["user_prompt", "The user's request"],
  ["final_answer", "The agent's final answer"],
  ["tool_calls", "Each tool call and its arguments"],
  ["tool_results", "Each tool step with its result"],
  ["expected_output", "The case's expected output"],
]);

/** What every judge creation path says about cost. Never a price. */
export const CUSTOM_JUDGE_COST_COPY =
  "Each judge adds a charged model call per graded iteration.";

/**
 * The backend's limits for author-written judges, from `judges.custom`. A
 * deployment that cannot run them allows none.
 */
export function customJudgeLimits(
  capabilities: Pick<SuiteCapabilities, "judges"> | null | undefined,
): { maxJudges: number; maxPromptLength: number } {
  const custom = capabilities?.judges?.custom;
  return {
    maxJudges: custom?.maxJudges ?? 0,
    maxPromptLength: custom?.maxPromptLength ?? 0,
  };
}

export function judgePromptVariables(names: readonly string[]): PromptVariable[] {
  return names.map((name) => ({
    name,
    description: VARIABLE_DESCRIPTIONS.get(name) ?? "Iteration data",
  }));
}

export function judgeProblem(
  judge: CustomJudge,
  others: readonly CustomJudge[],
  availableVariables: readonly string[],
  maxPromptLength: number,
): string | undefined {
  if (!judge.label.trim()) return "Give the judge a name.";
  if (!judge.prompt.trim()) return "Write the judge prompt.";
  if (judge.prompt.length > maxPromptLength) {
    return `Keep the prompt under ${maxPromptLength} characters.`;
  }
  const used = usedVariables(judge.prompt);
  const unknown = used.filter((name) => !availableVariables.includes(name));
  if (unknown.length) {
    return `${unknown.map((n) => `{{${n}}}`).join(", ")} ${unknown.length === 1 ? "isn't an available variable" : "aren't available variables"}.`;
  }
  if (used.length === 0) {
    return "Use at least one variable, such as {{final_answer}}, so the judge sees the run.";
  }
  if (
    judge.output.kind === "score" &&
    !(judge.output.threshold > 0 && judge.output.threshold <= 1)
  ) {
    return "Set a passing score above 0 and at most 1.";
  }
  if (others.some((o) => o.id === judge.id)) {
    return "Another judge in this suite has the same ID. Remove one of them, then save.";
  }
  return undefined;
}

function judgeIdFor(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "judge";
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * A new judge's ID is picked when its editor opens. If another judge took it
 * meanwhile (added from the library, say), the new judge takes the next free
 * ID instead of refusing to save.
 */
export function withFreeId(
  judge: CustomJudge,
  taken: readonly string[],
): CustomJudge {
  return taken.includes(judge.id)
    ? { ...judge, id: judgeIdFor("judge", taken) }
    : judge;
}

export function blankJudge(taken: readonly string[]): CustomJudge {
  return {
    id: judgeIdFor("judge", taken),
    label: "",
    prompt: "",
    output: { kind: "passfail" },
  };
}

/** Keep preset attribution on the editable copy. */
export function customizedCopy(
  judge: CustomJudge,
  taken: readonly string[],
): CustomJudge {
  const origin = judge.evaluator ?? judge.basedOn;
  return {
    id: judgeIdFor(`custom-${judge.label}`, taken),
    label: judge.label,
    prompt: judge.prompt,
    output: judge.output,
    ...(origin ? { basedOn: origin } : {}),
  };
}

/**
 * The config with these judges. The stored on/off switch is kept, and
 * callers check the backend's judge limit first, so nothing is dropped here.
 */
export function withJudges(
  judgeConfig: EvalJudgeConfig | undefined,
  judges: readonly CustomJudge[],
): EvalJudgeConfig {
  return {
    ...(judgeConfig ?? {}),
    customJudges: {
      enabled: judgeConfig?.customJudges?.enabled ?? true,
      judges: [...judges],
    },
  };
}
