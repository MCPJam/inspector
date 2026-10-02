import type {
  SuiteFileRunError,
  SuiteFileRunErrorCategory,
  SuiteFileRunResult,
} from "@mcpjam/sdk";
import { worstOf } from "./eval-run-exit-code.js";

/**
 * Exit codes for `mcpjam test`.
 *
 *   | Code | Meaning                                                            |
 *   |------|--------------------------------------------------------------------|
 *   | 0    | A completed, valid decision passed; requested artifacts written    |
 *   | 1    | A completed, valid decision failed — the ONLY source of 1          |
 *   | 2    | Invalid file/flags, unsupported local capability, import/approval  |
 *   |      | refusal, or an invalid tool-policy deny name                       |
 *   | 3    | Missing or rejected model/platform credentials, including a        |
 *   |      | credential rejected during execution                               |
 *   | 4    | Setup, connect, catalog, binding, interpolation or billing failure,|
 *   |      | or an artifact that could not be written                           |
 *   | 5    | Inconclusive, aborted, integrity/capture failure, or no complete   |
 *   |      | valid verdict                                                      |
 *
 * Usage (2) is returned DIRECTLY, never through `worstOf`: that merge ranks
 * `1 > 3 > 4 > 5 > 0` and does not know 2, so `worstOf([2])` is 0 — a refused
 * run would exit as a pass. Everything observed once execution or reporting
 * began merges through `worstOf`, so a failed decision stays 1 whatever else
 * went wrong, and infrastructure can never become 1.
 *
 * Nothing here recomputes a verdict: the decision is the SDK's, read.
 */
export const LOCAL_TEST_EXIT = {
  passed: 0,
  failed: 1,
  usage: 2,
  credentials: 3,
  setup: 4,
  notEstablished: 5,
} as const;

const USAGE_CATEGORIES: ReadonlySet<SuiteFileRunErrorCategory> = new Set([
  "usage",
  "unsupported",
  "import",
  "policy",
]);

/** The exit code for a run that was refused instead of returning evidence. */
export function localTestExitCodeForError(
  error: Pick<SuiteFileRunError, "category" | "phase">
): number {
  if (USAGE_CATEGORIES.has(error.category)) return LOCAL_TEST_EXIT.usage;
  switch (error.category) {
    case "credentials":
      return LOCAL_TEST_EXIT.credentials;
    case "billing":
    case "setup":
      return LOCAL_TEST_EXIT.setup;
    case "cancelled":
    case "integrity":
      return LOCAL_TEST_EXIT.notEstablished;
    default:
      // Unknown before execution is a setup problem; after it, nothing
      // complete was established.
      return error.phase === "validation" || error.phase === "setup"
        ? LOCAL_TEST_EXIT.setup
        : LOCAL_TEST_EXIT.notEstablished;
  }
}

/**
 * The exit code for a run that returned evidence, merged with anything the
 * CLI itself observed afterwards (an artifact it could not write).
 */
export function localTestExitCodeForResult(
  result: Pick<SuiteFileRunResult, "verdict" | "issues">,
  observed: { artifactWriteFailed?: boolean } = {}
): number {
  const codes: number[] = [];
  switch (result.verdict) {
    case "passed":
      codes.push(LOCAL_TEST_EXIT.passed);
      break;
    case "failed":
      codes.push(LOCAL_TEST_EXIT.failed);
      break;
    default:
      codes.push(LOCAL_TEST_EXIT.notEstablished);
  }
  for (const issue of result.issues) {
    if (issue.category === "credentials")
      codes.push(LOCAL_TEST_EXIT.credentials);
    else if (issue.category === "billing" || issue.category === "setup") {
      codes.push(LOCAL_TEST_EXIT.setup);
    } else if (
      issue.category === "integrity" ||
      issue.category === "internal"
    ) {
      codes.push(LOCAL_TEST_EXIT.notEstablished);
    }
    // Observer and cleanup issues are reported, never a changed outcome.
  }
  if (observed.artifactWriteFailed) codes.push(LOCAL_TEST_EXIT.setup);
  return worstOf(codes);
}
