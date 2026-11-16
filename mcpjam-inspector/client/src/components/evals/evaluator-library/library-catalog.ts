import type { Predicate } from "@mcpjam/sdk/predicates";
import type { RubricCheckQuestion } from "@/components/shared/session-quality/judge-config";
import {
  Braces,
  CircleCheck,
  MessageCircleWarning,
  Quote,
  FileWarning,
  Route,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { BuiltFromPart, EvaluatorTone } from "./evaluator-library-types";

/**
 * One library evaluator: a named bundle of assertions that already exist.
 * Adding it writes `checks` to the suite. Until the backend records which
 * evaluator a check came from, the checks show as ordinary assertion rows.
 */
export type LibraryEvaluator = {
  id: string;
  version: number;
  name: string;
  /** About this run, never about the server in general. */
  question: string;
  icon: LucideIcon;
  tone: EvaluatorTone;
  checks: readonly Predicate[];
  /**
   * Yes/no questions a model answers on the rubric-check pass, which rides
   * the goal-completion judge. Advisory, like every rubric check.
   */
  questions?: readonly LibraryQuestion[];
};

/** A library question before it is given its id and tag. */
export type LibraryQuestion = {
  slug: string;
  label: string;
  instructions: string;
  passOn: "yes" | "no";
};

export const LIBRARY_EVALUATORS: readonly LibraryEvaluator[] = [
  {
    id: "no-wasted-calls",
    version: 1,
    name: "No Wasted Calls",
    question:
      "Did the agent stay under 10 tool calls without repeating an identical call?",
    icon: Route,
    tone: "tools",
    checks: [
      { type: "toolCallCountUnder", count: 10 },
      // An observation: a repeat is what a poll loop looks like too, so the
      // schema only lets it advise.
      { type: "noRepeatedIdenticalCall", role: "advisory" },
    ],
  },
  {
    id: "valid-tool-arguments",
    version: 1,
    name: "Valid Tool Arguments",
    question: "Did every call send arguments that match the tool's schema?",
    icon: Wrench,
    tone: "tools",
    checks: [{ type: "argumentsMatchToolSchema" }],
  },
  {
    id: "results-match-output-schema",
    version: 1,
    name: "Results Match Output Schema",
    question:
      "Did every tool result in this run match the tool's declared output schema?",
    icon: Braces,
    tone: "tools",
    checks: [{ type: "toolResultMatchesSchema", schema: "declared" }],
  },
  {
    id: "delivers-final-answer",
    version: 1,
    name: "Delivers a Final Answer",
    question:
      "Did the agent end with an answer instead of an empty message or a question?",
    icon: CircleCheck,
    tone: "answer",
    checks: [
      { type: "finalAssistantMessageNonEmpty" },
      { type: "noEndingQuestion", role: "advisory" },
    ],
  },
  {
    id: "actionable-tool-errors",
    version: 1,
    name: "Actionable Tool Errors",
    question:
      "Did every tool call succeed, and did any error name the bad input?",
    icon: FileWarning,
    tone: "errors",
    checks: [
      { type: "noToolErrors" },
      { type: "toolErrorNamesInput", role: "advisory" },
    ],
  },
  {
    id: "reports-tool-errors",
    version: 1,
    name: "Reports Tool Errors",
    question:
      "When a tool failed, did the final answer say so instead of inventing a result?",
    icon: MessageCircleWarning,
    tone: "errors",
    checks: [],
    questions: [
      {
        slug: "invented",
        label: "Answer invented a result a tool did not return",
        instructions:
          "Compare the final answer with the tool results. Answer yes if the answer states a result that no tool returned, including after a tool error.",
        passOn: "no",
      },
    ],
  },
  {
    id: "answer-grounded-in-results",
    version: 1,
    name: "Answer Grounded in Results",
    question:
      "Is every factual claim in the answer backed by a tool result from this run?",
    icon: Quote,
    tone: "answer",
    checks: [],
    questions: [
      {
        slug: "grounded",
        label: "Every claim is backed by a tool result",
        instructions:
          "List the factual claims in the final answer and check each against the tool results in the recording. Answer yes only if every claim is supported.",
        passOn: "yes",
      },
    ],
  },
  {
    id: "avoids-risky-tools",
    version: 1,
    name: "Avoids Risky Tools",
    question:
      "Did the agent stay away from tools marked destructive or deprecated?",
    icon: ShieldAlert,
    tone: "security",
    checks: [
      { type: "noDestructiveToolCalled" },
      { type: "noDeprecatedToolCalled", role: "advisory" },
    ],
  },
];

/** The evaluator's checks, each tagged with where it came from. */
export function taggedChecks(evaluator: LibraryEvaluator): Predicate[] {
  return evaluator.checks.map((check) => ({
    ...check,
    evaluator: { id: evaluator.id, version: evaluator.version },
  }));
}

export function findLibraryEvaluator(id: string): LibraryEvaluator | undefined {
  return LIBRARY_EVALUATORS.find((evaluator) => evaluator.id === id);
}

/** Every check except the ones added from this evaluator. */
export function withoutEvaluator(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  return predicates.filter((p) => p.evaluator?.id !== evaluatorId);
}

/** The evaluator's questions, each with a stable id and its tag. */
export function taggedQuestions(
  evaluator: LibraryEvaluator,
): RubricCheckQuestion[] {
  return (evaluator.questions ?? []).map((q) => ({
    id: `${evaluator.id}-${q.slug}`,
    kind: "yesno",
    label: q.label,
    instructions: q.instructions,
    pass: { answer: q.passOn },
    evaluator: { id: evaluator.id, version: evaluator.version },
  }));
}

/** "2 assertions · 1 yes/no question", for the card footer. */
export function builtFrom(evaluator: LibraryEvaluator): BuiltFromPart[] {
  const parts: BuiltFromPart[] = [];
  const n = evaluator.checks.length;
  if (n) {
    parts.push({
      kind: "assertions",
      label: `${n} ${n === 1 ? "assertion" : "assertions"}`,
    });
  }
  const q = evaluator.questions?.length ?? 0;
  if (q) {
    parts.push({
      kind: "question",
      label: `${q} yes/no ${q === 1 ? "question" : "questions"}`,
    });
  }
  return parts;
}

/** True when the suite already has every check kind this evaluator adds. */
export function isInSuite(
  evaluator: LibraryEvaluator,
  predicates: readonly Predicate[],
  questions: readonly RubricCheckQuestion[] = [],
): boolean {
  const kinds = new Set(predicates.map((p) => p.type));
  const ids = new Set(questions.map((q) => q.id));
  return (
    evaluator.checks.every((check) => kinds.has(check.type)) &&
    taggedQuestions(evaluator).every((q) => ids.has(q.id))
  );
}

/** True when this deployment accepts every check kind the evaluator adds. */
export function isAuthorable(
  evaluator: LibraryEvaluator,
  authorableKinds: readonly Predicate["type"][] | undefined,
  canAskYesNo = false,
): boolean {
  if (evaluator.questions?.length && !canAskYesNo) return false;
  if (!authorableKinds) return true;
  return evaluator.checks.every((check) =>
    authorableKinds.includes(check.type),
  );
}
