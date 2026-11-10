import { setRequestLocal } from "../../middleware/request-local.js";
import type { TurnResources } from "./resources.js";
import type { Context } from "hono";
import type { InternalExecutionTarget } from "../../../shared/execution-target.js";
import { HOSTED_MODE } from "../../config.js";
import { verifyAuthKitToken } from "../authkit-jwt.js";
import { turnAuthorizations, type TurnAuthorization } from "../turn-authorization.js";
import { preparePersistenceAuthorization } from "./persistence-authorization.js";

import { authorizeProject, callerContextFromHono } from "../../routes/web/auth.js";
import { chatPreparationRequest } from "./resolve-chat-turn.js";

/** Keep project proof scoped to the request and bearer that obtained it. */
export async function authorizeManagedProject(c: Context, bearer: string, scope: {
  projectId: string;
  chatSessionId?: string;
  target: Exclude<InternalExecutionTarget, { kind: "scenario" }>;
  serverIds: string[];
}) {
  const guest = Boolean(c.get("guestId"));
  const { projectId, chatSessionId, target, serverIds } = scope;
  const authorized = await authorizeProject(
    callerContextFromHono(c), bearer, projectId,
    guest ? undefined : chatSessionId,
    !guest && (target.kind === "host" || target.kind === "adhoc")
      ? chatPreparationRequest(projectId, target, { kind: "explicit", serverIds })
      : undefined,
    c.req.raw.signal,
  );
  if (authorized?.organizationId && authorized.projectAccess) {
    setRequestLocal(c, "authorizedProject", {
      projectId, organizationId: authorized.organizationId, bearer,
    });
  }
  return authorized;
}

export async function prepareTurnAuthorization(c: Context, scope: {
  projectId: string;
  chatSessionId?: string;
  executionTarget: InternalExecutionTarget;
  requestId?: string;
  harness?: string;
}, resources: Pick<TurnResources, "own">): Promise<TurnAuthorization | undefined> {
  if (!scope.chatSessionId || scope.executionTarget.kind === "scenario") return;
  const own = (authorization: TurnAuthorization) => {
    resources.own(() => authorization.dispose());
    setRequestLocal(c, "turnAuthorizationBearer", async () =>
      (await authorization.getAuthorization()).replace(/^Bearer\s+/i, ""),
    );
    return authorization;
  };
  const delegated = await preparePersistenceAuthorization(c, { ...scope, includeNativeApiKey: true });
  if (delegated) return own({ start() {}, getAuthorization: delegated, getCleanupAuthorization: delegated, dispose() {} });
  if (HOSTED_MODE || c.get("authMethod") !== "authkit_jwt" || !scope.requestId) return;
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const verified = await verifyAuthKitToken(token, undefined, { allowMcpResourceAudience: true });
  if (!verified.sid || verified.sub !== c.get("workosUserId")) return;
  const sessionId = verified.sid;
  let lease: ReturnType<typeof turnAuthorizations.create> | undefined;
  let disposed = false;
  const { projectId, chatSessionId, requestId } = scope;
  return own({
    start(turnId, writer) {
      if (disposed || lease) return;
      lease = turnAuthorizations.create({ subject: verified.sub, sessionId,
        organizationId: verified.orgId }, { projectId, chatSessionId, requestId, turnId }, token, c.req.raw.signal);
      writer.write({ type: "data-turn-authorization", transient: true, data: lease.data });
    },
    async getCleanupAuthorization() {
      if (lease) return lease.getCleanupAuthorization();
      await verifyAuthKitToken(token, undefined, { allowMcpResourceAudience: true });
      return `Bearer ${token}`;
    },
    async getAuthorization() {
      if (disposed) throw new Error("Turn authorization is closed");
      if (lease) return lease.getAuthorization();
      await verifyAuthKitToken(token, undefined, { allowMcpResourceAudience: true });
      return `Bearer ${token}`;
    },
    dispose() { disposed = true; lease?.dispose(); },
  });
}
