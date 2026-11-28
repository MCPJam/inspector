/**
 * The backend refuses a run whose code evaluators or scripts it can't honour
 * (EFTW-90's `assertCodeEvaluatorRunPreconditions`) before creating anything.
 * Its message already says what the suite needs and what to do, so it goes
 * back as the launch's 400 with its reason and rule, which lets the app link
 * to the suite on MCPJam when only MCPJam's runners can run it, rather than
 * as a 500 that hides it.
 */
import { ConvexError } from "convex/values";
import { CODE_EVALUATORS_UNAVAILABLE } from "../../../../shared/local-eval-venue.js";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors.js";

export { CODE_EVALUATORS_UNAVAILABLE };

export function codeEvaluatorRunRefusalError(error: unknown): WebRouteError | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown; message?: unknown; reason?: unknown } | null;
  if (!data || typeof data !== "object" || data.code !== CODE_EVALUATORS_UNAVAILABLE) return null;
  if (typeof data.message !== "string" || !data.message.trim()) return null;
  return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, data.message, {
    // `code` as the backend sent it, for callers that already read it.
    code: CODE_EVALUATORS_UNAVAILABLE,
    reason: CODE_EVALUATORS_UNAVAILABLE,
    // Which rule refused: a local run, an Inspector without eval sandboxes,
    // or grading that isn't on.
    ...(typeof data.reason === "string" ? { rule: data.reason } : {}),
  });
}
