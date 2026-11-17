import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import { abortable } from "../sessionSimulation/target-discovery.js";
import { hasServiceCredential } from "../service-credential.js";
import type { Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { getRequestLocal, setRequestLocal } from "../../middleware/request-local.js";
import { resolveAgentRegistrationCaller } from "../agent-registration-caller.js";
import { isOrgBoundCredential } from "../../utils/org-bound-credential.js";
import { getBackgroundRunBearerForRequest } from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

/** Revalidate the original identity before each delegated turn operation. */
export async function preparePersistenceAuthorization(
  c: Context,
  scope: {
    projectId: string;
    chatSessionId?: string;
    executionTarget: InternalExecutionTarget;
    includeNativeApiKey?: boolean;
  },
): Promise<(() => Promise<string>) | undefined> {
  if (!scope.chatSessionId || scope.executionTarget.kind === "scenario") return;
  return prepareBackgroundRequestAuthorization(c, scope.projectId, scope);
}

/** Same original principal and project, checked again before each deferred use. */
export async function prepareBackgroundRequestAuthorization(
  c: Context,
  projectId: string,
  options: { includeNativeApiKey?: boolean; lazy?: boolean } = {},
): Promise<(() => Promise<string>) | undefined> {
  const method = c.get("authMethod");
  if (
    (!HOSTED_MODE && !(options.includeNativeApiKey && isOrgBoundCredential(method))) ||
    !hasServiceCredential() ||
    c.get("guestId") ||
    (method !== "authkit_jwt" && !isOrgBoundCredential(method))
  )
    return;
  const prepare = () => abortable(
    getBackgroundRunBearerForRequest(c, projectId, {
      requireFreshSessionOnUse: true, allowOriginalBearerOnMintFailure: true,
    }),
    AbortSignal.timeout(20_000),
  );
  let prepared = options.lazy ? undefined : prepare();
  if (prepared) await prepared;
  let inFlight: Promise<string> | undefined;
  const subject = c.get("workosUserId");
  const organizationId = c.get("mcpjamOrganizationId");
  const resolve = async () => {
    const signal = AbortSignal.timeout(10_000);
    if (isOrgBoundCredential(method)) {
      const refused = await abortable(
        recheckOrgBoundCredential(c, method),
        signal,
      );
      if (
        refused ||
        c.get("workosUserId") !== subject ||
        c.get("mcpjamOrganizationId") !== organizationId
      ) {
        throw new WebRouteError(
          403,
          ErrorCode.FORBIDDEN,
          "Your access changed during this turn. Sign in again.",
        );
      }
    }
    // Defer delegation until an operation needs it; metadata-only requests
    // must not mint execution credentials. Concurrent reads share only the
    // in-flight check, never a completed authorization result.
    prepared ??= prepare();
    const getBearer = await prepared;
    return `Bearer ${await abortable(getBearer(), signal)}`;
  };
  return () => {
    inFlight ??= resolve().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

/**
 * Recheck an org-bound caller before a deferred use; true means refused. The
 * normal request memo predates the long turn. An `sk_` key is revalidated from
 * scratch, current organization binding included. An agent token lives five
 * minutes and may have expired mid-turn, so the agent's user and organization
 * are resolved again from the claims it arrived with: work it started
 * completes, and org membership is still checked where the delegated token is
 * minted.
 */
async function recheckOrgBoundCredential(
  c: Context,
  method: "workos_api_key" | "workos_agent",
): Promise<boolean> {
  if (method === "workos_agent") {
    const claims = getRequestLocal(c, "workosAgentClaims");
    if (!claims) return true;
    const caller = await resolveAgentRegistrationCaller(claims);
    setRequestLocal(c, "workosAgentCaller", caller);
    return (
      !caller.ok ||
      caller.workosUserId !== c.get("workosUserId") ||
      caller.mcpjamOrganizationId !== c.get("mcpjamOrganizationId")
    );
  }
  setRequestLocal(c, "workosApiKeyValidation", undefined);
  setRequestLocal(c, "workosApiKeyBinding", undefined);
  return Boolean(await bearerAuthMiddleware(c, async () => {}));
}
