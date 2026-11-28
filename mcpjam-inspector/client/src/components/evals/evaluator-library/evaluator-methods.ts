import { ListChecks, ListTodo, Scale, type LucideIcon } from "lucide-react";
import { CUSTOM_JUDGE_COST_COPY } from "./custom-judges-model";
import type { EvaluatorMethod } from "./evaluator-library-types";

export const EVALUATOR_METHODS = [
  {
    value: "assertions",
    title: "Assertions",
    description: "Combine built-in checks.",
    icon: ListChecks,
    tone: "bg-info/10 text-info",
  },
  {
    value: "decision",
    title: "Decision questions",
    description: "Ask yes/no, choice, or score questions.",
    icon: ListTodo,
    tone: "bg-success/10 text-success",
  },
  {
    value: "judge",
    title: "Judge prompt",
    description: `Grade an iteration with a prompt. ${CUSTOM_JUDGE_COST_COPY}`,
    icon: Scale,
    tone: "bg-primary/10 text-primary",
  },
] as const satisfies readonly {
  value: EvaluatorMethod;
  title: string;
  description: string;
  icon: LucideIcon;
  tone: string;
}[];
