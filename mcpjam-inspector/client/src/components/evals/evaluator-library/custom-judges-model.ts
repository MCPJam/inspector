import {
  MAX_CUSTOM_JUDGE_PROMPT_LENGTH,
  MAX_CUSTOM_JUDGES,
  type CustomJudge,
} from "@/components/shared/session-quality/judge-config";
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

export function judgePromptVariables(names: readonly string[]): PromptVariable[] {
  return names.map((name) => ({
    name,
    path: VARIABLE_DESCRIPTIONS.get(name) ?? "Trial data",
  }));
}

export function judgeProblem(
  judge: CustomJudge,
  others: readonly CustomJudge[],
  availableVariables: readonly string[],
  variableAliases?: Readonly<Record<string, string>>,
): string | undefined {
  if (!judge.label.trim()) return "Give the judge a name.";
  if (!judge.prompt.trim()) return "Write the judge prompt.";
  if (judge.prompt.length > MAX_CUSTOM_JUDGE_PROMPT_LENGTH) {
    return `Keep the prompt under ${MAX_CUSTOM_JUDGE_PROMPT_LENGTH} characters.`;
  }
  const used = usedVariables(judge.prompt);
  const unknown = used.filter(
    (name) =>
      !availableVariables.includes(name) &&
      !(variableAliases &&
        Object.hasOwn(variableAliases, name) &&
        availableVariables.includes(variableAliases[name])),
  );
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
  if (others.some((o) => o.id === judge.id))
    return "Judge ID already used. Close and reopen the editor.";
  return undefined;
}

export function judgeIdFor(label: string, taken: readonly string[]): string {
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

export function withJudges(
  judgeConfig: EvalJudgeConfig | undefined,
  judges: readonly CustomJudge[],
): EvalJudgeConfig {
  return {
    ...(judgeConfig ?? {}),
    customJudges: {
      enabled: judgeConfig?.customJudges?.enabled ?? true,
      judges: judges.slice(0, MAX_CUSTOM_JUDGES),
    },
  };
}
