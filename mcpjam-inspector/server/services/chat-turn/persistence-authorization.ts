import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import { abortable } from "../sessionSimulation/target-discovery.js";
import { hasServiceCredential } from "../service-credential.js";
import type { Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { bearerAuthMiddleware } from "../../middleware/bearer-auth.js";
import { setRequestLocal } from "../../middleware/request-local.js";
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
  options: { includeNativeApiKey?: boolean } = {},
): Promise<(() => Promise<string>) | undefined> {
  const method = c.get("authMethod");
  if (
    (!HOSTED_MODE && !(options.includeNativeApiKey && method === "workos_api_key")) ||
    !hasServiceCredential() ||
    c.get("guestId") ||
    (method !== "authkit_jwt" && method !== "workos_api_key")
  )
    return;
  const getBearer = await abortable(
    getBackgroundRunBearerForRequest(c, projectId, {
      requireFreshSessionOnUse: true,
    }),
    AbortSignal.timeout(20_000),
  );
  const subject = c.get("workosUserId");
  const organizationId = c.get("mcpjamOrganizationId");
  return async () => {
    const signal = AbortSignal.timeout(10_000);
    if (method === "workos_api_key") {
      // The normal request memo predates the long turn. Recheck the same key,
      // including its current organization binding, before using delegation.
      setRequestLocal(c, "workosApiKeyValidation", undefined);
      setRequestLocal(c, "workosApiKeyBinding", undefined);
      const refusal = await abortable(
        bearerAuthMiddleware(c, async () => {}),
        signal,
      );
      if (
        refusal ||
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
    return `Bearer ${await abortable(getBearer(), signal)}`;
  };
}
