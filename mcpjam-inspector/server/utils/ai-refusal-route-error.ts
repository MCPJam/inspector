/**
 * The organization AI-key policy's refusals ("Use your keys for all AI
 * features") as a route answer.
 *
 * The backend refuses with a closed set of codes (`org_keys_required`,
 * `org_model_unconfigured`, …; `shared/ai-execution-refusal.ts`) at three
 * places this server sees: a ConvexError from a launch mutation (eval suite
 * runs, quick runs), a typed {@link ModelResolutionRefusalError} from the
 * runtime resolver, and the backend stream routes (classified separately by
 * `describeBackendStreamFailure`). Without a translation the first two reach
 * the caller as an opaque 500 — which also pages, for a refusal that is the
 * organization's own configuration working as designed.
 *
 * The answer keeps the backend's code in `details.code` (and its remediation
 * in `details.remediation`), which is what the client keys its copy on and
 * what the CLI reads to exit with its configuration code rather than the
 * auth-shaped one. The status mirrors the backend's: 403 for
 * `org_keys_required` / `ai_scope_unresolved`, 422 for the rest.
 *
 * Translated: the CONFIGURATION refusals, the reused model-resolution codes a
 * launch preflight can lead with (`invalid_model`, `capability_missing`,
 * `capability_unknown`), and any launch refusal that carries its `problems`
 * list whatever its primary code. The two transient ones
 * (`ai_policy_unavailable`, `provider_unavailable`) are left to the ordinary
 * error path, which treats them as the retryable failures they are.
 */
import { ConvexError } from "convex/values";
import { describeAsSlug, orgPolicySlugForCode } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import {
  AI_RETRYABLE_REFUSAL_CODES,
  aiRefusalRemediation,
  isAiConfigurationRefusalCode,
  isRecognizedAiRefusalCode,
} from "../../shared/ai-execution-refusal.js";
import { ModelResolutionRefusalError } from "./model-resolution-local.js";

const FORBIDDEN_CODES: ReadonlySet<string> = new Set([
  "org_keys_required",
  "ai_scope_unresolved",
]);

/**
 * Catalog slugs for the reused codes, which predate the policy and have no
 * `org/*` slug of their own. The backend pairs the model codes with
 * `configure_org_model_role`.
 */
const SLUG_BY_REUSED_CODE: Readonly<Record<string, string>> = {
  credential_missing: "org/credential_missing",
  capability_missing: "org/model_unconfigured",
  capability_unknown: "org/model_unconfigured",
  invalid_model: "org/model_unconfigured",
};

/** The catalog slug for a configuration refusal code. */
function slugForCode(code: string): string {
  return (
    orgPolicySlugForCode(code) ??
    SLUG_BY_REUSED_CODE[code] ??
    "org/keys_required"
  );
}

/**
 * Build the route error for one configuration refusal. `details` rides along
 * (the launch refusal's `problems` list, for one); `code` and `remediation`
 * always win.
 */
export function aiRefusalRouteError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): WebRouteError {
  const normalizedCode = code.trim().toLowerCase();
  const status = FORBIDDEN_CODES.has(normalizedCode) ? 403 : 422;
  return new WebRouteError(
    status,
    status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.FEATURE_NOT_SUPPORTED,
    message,
    {
      ...(details ?? {}),
      code: normalizedCode,
      remediation: aiRefusalRemediation(normalizedCode),
    },
    describeAsSlug(
      slugForCode(normalizedCode),
      new Error(`${normalizedCode}: ${message}`),
    ),
  );
}

/**
 * The route error for an organization AI-key policy configuration refusal,
 * or `null` for anything else (so a caller falls through to its own handling).
 */
export function asAiRefusalRouteError(error: unknown): WebRouteError | null {
  if (error instanceof WebRouteError) return null;
  if (
    error instanceof ModelResolutionRefusalError &&
    isAiConfigurationRefusalCode(error.code)
  ) {
    return aiRefusalRouteError(error.code, error.message, {
      refusals: error.refusals.map((refusal) => ({
        code: refusal.code,
        reason: refusal.reason,
      })),
    });
  }
  if (error instanceof ConvexError) {
    const data = error.data as
      | { code?: unknown; message?: unknown; problems?: unknown }
      | undefined
      | null;
    if (
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      typeof data.code === "string" &&
      !AI_RETRYABLE_REFUSAL_CODES.has(data.code.trim().toLowerCase()) &&
      // A launch preflight's refusal lists every unavailable dependency in
      // `problems`, and its primary code can be a reused one
      // (`invalid_model`, …): still the organization's configuration.
      (Array.isArray(data.problems) || isRecognizedAiRefusalCode(data.code))
    ) {
      const message =
        typeof data.message === "string" && data.message.trim()
          ? data.message
          : "This organization's AI configuration cannot run this request.";
      return aiRefusalRouteError(
        data.code,
        message,
        data as Record<string, unknown>,
      );
    }
  }
  return null;
}
