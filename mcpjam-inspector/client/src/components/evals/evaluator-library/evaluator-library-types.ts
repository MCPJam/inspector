/**
 * Shared vocabulary for the evaluator library components.
 *
 * These are presentation types: they describe what a library card or badge
 * shows, not how an evaluator runs. The runtime shapes live in
 * `@mcpjam/evaluators` (`Evaluator`, `EvaluatorDefinition`), and nothing here
 * should grow fields that duplicate them.
 */

/** How an evaluator decides: the library's Method cards. */
export type EvaluatorMethod = "assertions" | "judge" | "decision";

/** Where an evaluator in a suite came from. */
export type EvaluatorOrigin = "library";

/** Icon tile tone, one per library group. */
export type EvaluatorTone = "tools" | "answer" | "errors" | "security";

/** One piece of what an evaluator is built from, e.g. "3 assertions". */
export type BuiltFromPart = {
  kind: "assertions" | "question" | "judge" | "pattern";
  label: string;
};
