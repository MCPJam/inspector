import {
  CUSTOM_JUDGE_VARIABLES,
  MAX_CUSTOM_JUDGE_PROMPT_LENGTH,
  MAX_CUSTOM_JUDGES,
  type CustomJudge,
} from "@/components/shared/session-quality/judge-config";
import type { EvalJudgeConfig } from "../types";
import { usedVariables } from "./prompt-editor";
import type { PromptVariable } from "./variable-mapping-table";

/** The run data a judge prompt may name, with where each comes from. */
export const JUDGE_PROMPT_VARIABLES: readonly PromptVariable[] = [
  { name: "user_prompt", path: "The user's request" },
  { name: "final_answer", path: "The agent's final answer" },
  { name: "tool_calls", path: "Each tool call and its arguments" },
  { name: "tool_results", path: "Each tool step with its result" },
  { name: "expected_outcome", path: "The case's expected outcome" },
];

/** Mirrors the backend's write-time checks, so a save is not refused later. */
export function judgeProblem(
  judge: CustomJudge,
  others: readonly CustomJudge[],
): string | undefined {
  if (!judge.label.trim()) return "Give the judge a name.";
  if (!judge.prompt.trim()) return "Write the judge prompt.";
  if (judge.prompt.length > MAX_CUSTOM_JUDGE_PROMPT_LENGTH) {
    return `Keep the prompt under ${MAX_CUSTOM_JUDGE_PROMPT_LENGTH} characters.`;
  }
  const used = usedVariables(judge.prompt);
  const unknown = used.filter(
    (name) => !(CUSTOM_JUDGE_VARIABLES as readonly string[]).includes(name),
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
  if (others.some((o) => o.id === judge.id)) return "Another judge has this id.";
  return undefined;
}

/** A lowercase id the backend accepts, unique among `taken`. */
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

/**
 * An editable copy of a library judge. It replaces the library judge, so the
 * trial is not graded twice, and keeps a "based on" note instead of an
 * update offer.
 */
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

/** The config with its judges list replaced; always keeps other slots. */
export function withJudges(
  judgeConfig: EvalJudgeConfig | undefined,
  judges: readonly CustomJudge[],
): EvalJudgeConfig {
  return {
    ...(judgeConfig ?? {}),
    customJudges: {
      enabled: true,
      judges: judges.slice(0, MAX_CUSTOM_JUDGES),
    },
  };
}
