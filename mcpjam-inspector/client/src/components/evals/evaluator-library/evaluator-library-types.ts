/**
 * Shared vocabulary for the evaluator library components.
 *
 * These are presentation types: they describe what a library card or badge
 * shows, not how an evaluator runs. The runtime shapes live in
 * `@mcpjam/evaluators` (`Evaluator`, `EvaluatorDefinition`), and nothing here
 * should grow fields that duplicate them.
 */

/** The OWASP MCP Top 10 (2025) items a security evaluator can cover. */
export type OwaspId =
  | "MCP01"
  | "MCP02"
  | "MCP03"
  | "MCP04"
  | "MCP05"
  | "MCP06"
  | "MCP07"
  | "MCP08"
  | "MCP09"
  | "MCP10";

/** How an evaluator decides. */
export type EvaluatorMethod = "assertions" | "judge" | "decision";

/** Where an evaluator in a suite came from. */
export type EvaluatorOrigin = "library" | "library-copy" | "github";

/**
 * A field the test case declares and an evaluator compares the run against.
 * An evaluator that reads a field the case leaves empty reports Not
 * applicable for that case, so the author needs to see the dependency.
 */
export type CaseField =
  | "expectedToolCalls"
  | "callBudget"
  | "expectedOutput"
  | "expectsClarification"
  | "postCondition"
  | "attackFixture"
  | "allowedPersonalData";

/** Icon tile tone, one per library group. */
export type EvaluatorTone = "tools" | "answer" | "errors" | "security";

/** One piece of what an evaluator is built from, e.g. "3 assertions". */
export type BuiltFromPart = {
  kind: "assertions" | "question" | "judge" | "pattern";
  label: string;
};
