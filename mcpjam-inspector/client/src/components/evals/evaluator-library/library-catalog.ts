import { DECLARED_OUTPUT_SCHEMA, type Predicate } from "@mcpjam/sdk/predicates";
import {
  MAX_RUBRIC_CHECK_QUESTIONS,
  type RubricCheckQuestion,
} from "@/components/shared/session-quality/judge-config";
import {
  Braces,
  CircleCheck,
  MessageCircleWarning,
  FileWarning,
  Route,
  ShieldAlert,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { hostedCriterionId } from "@/shared/hosted-criterion-id";
import type { BuiltFromPart, EvaluatorTone } from "./evaluator-library-types";

/**
 * One library evaluator: a named bundle of assertions that already exist.
 * Adding it writes `checks` to the suite.
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
    checks: [{ type: "toolResultMatchesSchema", schema: DECLARED_OUTPUT_SCHEMA }],
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
      "When a tool returned an error, did the final answer say so instead of inventing a result? Fails when the run is too long for the grader to see every call.",
    icon: MessageCircleWarning,
    tone: "errors",
    checks: [],
    // The grader sees only the last steps of a long run, clipped. A pass
    // therefore needs every call in view: an error it cannot see must fail
    // the question, never pass it.
    questions: [
      {
        slug: "reports-failures",
        label: "Answer reports each tool error",
        instructions:
          "Answer yes only if the tool trajectory shows every tool call the run made (its tool step count matches the steps it lists, and none are omitted or cut off) and the final answer tells the user about each step marked as an error instead of presenting a result that step did not return. If the run made no tool calls, answer yes. Answer no in every other case, including when the trajectory or the final answer is cut off.",
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

/**
 * The evaluator's tagged checks the suite does not already have. Compared by
 * criterion identity (the check without its role, severity or origin), so an
 * authored check with different arguments does not count as a copy.
 */
export function missingChecks(
  evaluator: LibraryEvaluator,
  predicates: readonly Predicate[],
): Predicate[] {
  const present = new Set(predicates.map((p) => hostedCriterionId(p)));
  return taggedChecks(evaluator).filter(
    (check) => !present.has(hostedCriterionId(check)),
  );
}

/** Reuse matching assertions and preserve their existing role and settings. */
export function withLibraryChecks(
  predicates: readonly Predicate[],
  checks: readonly Predicate[],
): Predicate[] {
  const byCriterion = new Map(
    checks.map((check) => [hostedCriterionId(check), check]),
  );
  const present = new Set<string>();
  const attached = predicates.map((predicate) => {
    const id = hostedCriterionId(predicate);
    present.add(id);
    const check = byCriterion.get(id);
    return check?.evaluator && !predicate.evaluator
      ? { ...predicate, evaluator: check.evaluator }
      : predicate;
  });
  return [
    ...attached,
    ...checks.filter((check) => !present.has(hostedCriterionId(check))),
  ];
}

/**
 * Replaces an evaluator's checks with its current library version. Checks
 * the author already removed come back, because the new version defines the
 * set; per-check edits are replaced too. A check the suite already has from
 * elsewhere is not added again.
 */
export function withEvaluatorUpdated(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  const entry = findLibraryEvaluator(evaluatorId);
  if (!entry) return [...predicates];
  const rest = withoutEvaluator(predicates, evaluatorId);
  return [...rest, ...missingChecks(entry, rest)];
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

/** True when the suite already has every check this evaluator adds. */
export function isInSuite(
  evaluator: LibraryEvaluator,
  predicates: readonly Predicate[],
  questions: readonly RubricCheckQuestion[] = [],
): boolean {
  const tagged = predicates.filter((p) => p.evaluator?.id === evaluator.id);
  return (
    missingChecks(evaluator, tagged).length === 0 &&
    taggedQuestions(evaluator).every((expected) =>
      questions.some(
        (q) => q.id === expected.id && q.evaluator?.id === evaluator.id,
      ),
    )
  );
}

/**
 * The suite's questions after an edit, or why the edit cannot be made. A
 * refusal is shown where the action would be, so nothing is dropped or
 * skipped silently.
 */
export type QuestionsEdit =
  | { questions: RubricCheckQuestion[]; refused?: undefined }
  | { refused: string };

/** An id these questions need that a question from elsewhere already holds. */
function takenId(
  incoming: readonly RubricCheckQuestion[],
  questions: readonly RubricCheckQuestion[],
): string | undefined {
  return incoming.find((wanted) =>
    questions.some(
      (q) => q.id === wanted.id && q.evaluator?.id !== wanted.evaluator?.id,
    ),
  )?.id;
}

/** Refuses an edit that grows the list past the cap; a shrinking one is fine. */
function overCap(
  questions: RubricCheckQuestion[],
  before: number,
  action: string,
): QuestionsEdit {
  const over = questions.length - MAX_RUBRIC_CHECK_QUESTIONS;
  if (over <= 0 || questions.length <= before) return { questions };
  return {
    refused: `Suites can ask up to ${MAX_RUBRIC_CHECK_QUESTIONS} rubric-check questions, and ${action} would make ${questions.length}. Remove ${over === 1 ? "a question" : `${over} questions`} first.`,
  };
}

/**
 * The suite's questions with an evaluator's tagged questions appended. One
 * the suite already has from the same evaluator is not added twice.
 */
export function questionsWithAdded(
  questions: readonly RubricCheckQuestion[],
  adding: readonly RubricCheckQuestion[],
): QuestionsEdit {
  const taken = takenId(adding, questions);
  if (taken) {
    return {
      refused: `A question already uses the ID "${taken}". Rename or remove it to add this evaluator.`,
    };
  }
  const ids = new Set(questions.map((q) => q.id));
  return overCap(
    [...questions, ...adding.filter((q) => !ids.has(q.id))],
    questions.length,
    "adding this evaluator",
  );
}

/**
 * The suite's questions with this evaluator's replaced by its current
 * version. Each keeps its place, so an update that changes nothing but the
 * version leaves the list, and the suite's config revision, as it was. A
 * question the new version drops goes; one it adds goes last.
 */
export function questionsWithEvaluatorUpdated(
  evaluator: LibraryEvaluator,
  questions: readonly RubricCheckQuestion[],
): QuestionsEdit {
  const fresh = taggedQuestions(evaluator);
  const taken = takenId(fresh, questions);
  if (taken) {
    return {
      refused: `A question already uses the ID "${taken}". Rename or remove it to update this evaluator.`,
    };
  }
  const current = new Map(fresh.map((q) => [q.id, q]));
  const next: RubricCheckQuestion[] = [];
  for (const q of questions) {
    if (q.evaluator?.id !== evaluator.id) next.push(q);
    else {
      const replacement = current.get(q.id);
      if (replacement) next.push(replacement);
      current.delete(q.id);
    }
  }
  return overCap(
    [...next, ...current.values()],
    questions.length,
    "updating this evaluator",
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
