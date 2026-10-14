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
 * A build without a backend URL has no policy to read and runs as before.
 * A configured backend
 * with missing credentials or a failed read refuses the run as
 * retryable `ai_key_policy_unavailable` rather than spending the request's keys
 * on data whose policy is unknown.
 *
 * Shared by suite runs, single-case runs (`routes/shared/evals.ts`) and
 * replays (`replay-suite-run.ts`) and chat turns (`utils/own-key-turn-policy.ts`).
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

/** Resolve request-supplied credentials before a launch reserves any work. */
export async function prepareClientKeyRun(
  request: Pick<ResolveOrgModelConfigAuth, "scenarioId" | "accessVersion"> & {
    modelApiKeys?: Record<string, string>;
    orgModelConfig?: ResolvedOrgModelConfig;
    convexAuthToken?: string;
  },
  projectId: string | undefined,
  serverIds: string[],
) {
  const { modelApiKeys, orgModelConfig } = request;
  const keys =
    modelApiKeys && Object.keys(modelApiKeys).length > 0
      ? modelApiKeys
      : undefined;
  const config =
    keys && !orgModelConfig && projectId
      ? await orgPolicyConfigForClientKeys(
          { projectId },
          {
            bearerToken: request.convexAuthToken,
            scenarioId: request.scenarioId,
            accessVersion: request.accessVersion,
            serverIds,
          },
        )
      : orgModelConfig;
  return { modelApiKeys: keys, orgModelConfig: config };
}
