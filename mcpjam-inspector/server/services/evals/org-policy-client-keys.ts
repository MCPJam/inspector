import { logger } from "../../utils/logger.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  orgRequiresOwnKeys,
  resolveOrgModelConfig,
  type ResolveOrgModelConfigAuth,
  type ResolveOrgModelConfigTarget,
  type ResolvedOrgModelConfig,
} from "../../utils/org-model-config.js";

/**
 * The organization config a run carries when the request brings its own model
 * keys. Those keys never consult the organization, so its AI-key policy is
 * read anyway: while the organization requires its own keys, the run carries
 * the resolved config (which withholds every key), and the runner refuses
 * personal, local and hosted selections with `org_keys_required` instead of
 * running them on the request's keys. Off the policy the request's keys run
 * exactly as before, with no org config.
 *
 * A build that cannot reach the organization's config at all (no backend URL,
 * no credential or bearer, a backend without the route) has no policy to read
 * and runs as before. A read that FAILS fails closed: the run is refused as
 * retryable `ai_key_policy_unavailable` rather than spending the request's keys
 * on data whose policy is unknown.
 *
 * Shared by suite runs, single-case runs (`routes/shared/evals.ts`),
 * replays (`replay-suite-run.ts`) and chat turns on their own keys
 * (`utils/own-key-turn-policy.ts`), so it lives apart from the route module.
 */
export async function orgPolicyConfigForClientKeys(
  target: ResolveOrgModelConfigTarget,
  auth: ResolveOrgModelConfigAuth,
): Promise<ResolvedOrgModelConfig | undefined> {
  if (!process.env.CONVEX_HTTP_URL) return undefined;
  try {
    const config = await resolveOrgModelConfig(target, auth);
    return orgRequiresOwnKeys(config) ? config : undefined;
  } catch (error) {
    logger.warn("[evals] Failed to read the org AI-key policy", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new WebRouteError(
      503,
      ErrorCode.SERVER_UNREACHABLE,
      "The organization's AI key policy could not be read, so this run can't start on its own keys yet. Try again.",
      { code: "ai_key_policy_unavailable", isRetryable: true },
    );
  }
}
