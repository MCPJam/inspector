import type { Predicate } from "@mcpjam/sdk/predicates";
import {
  Braces,
  CircleCheck,
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

/**
 * Replaces an evaluator's checks with its current library version. Checks
 * the author already removed come back, because the new version defines the
 * set; per-check edits are replaced too.
 */
export function withEvaluatorUpdated(
  predicates: readonly Predicate[],
  evaluatorId: string,
): Predicate[] {
  const entry = findLibraryEvaluator(evaluatorId);
  if (!entry) return [...predicates];
  return [...withoutEvaluator(predicates, evaluatorId), ...taggedChecks(entry)];
}

/** "2 assertions", for the card footer. */
export function builtFrom(evaluator: LibraryEvaluator): BuiltFromPart[] {
  const n = evaluator.checks.length;
  return [
    {
      kind: "assertions",
      label: `${n} ${n === 1 ? "assertion" : "assertions"}`,
    },
  ];
}

/** True when the suite already has every check kind this evaluator adds. */
export function isInSuite(
  evaluator: LibraryEvaluator,
  predicates: readonly Predicate[],
): boolean {
  const kinds = new Set(predicates.map((p) => p.type));
  return evaluator.checks.every((check) => kinds.has(check.type));
}

/** True when this deployment accepts every check kind the evaluator adds. */
export function isAuthorable(
  evaluator: LibraryEvaluator,
  authorableKinds: readonly Predicate["type"][] | undefined,
): boolean {
  if (!authorableKinds) return true;
  return evaluator.checks.every((check) =>
    authorableKinds.includes(check.type),
  );
}
