import type { Context } from "hono";
import { HOSTED_MODE } from "../../config.js";
import { setRequestLocal } from "../../middleware/request-local.js";
import { verifyAuthKitToken } from "../authkit-jwt.js";
import {
  turnAuthorizations,
  type TurnAuthorizationOwner,
} from "../turn-authorization.js";
import {
  getConvexBearerForRequest,
} from "../../utils/v1-convex-token.js";
import { prepareBackgroundRequestAuthorization } from "../chat-turn/persistence-authorization.js";
import { pluginBindingDigest } from "./bindings.js";
import {
  PluginInvocationError,
  sanitizePluginToolParams,
  type PluginToolCallParams,
  type PluginInvocationOrigin,
} from "./invocation.js";
import type {
  PluginFormOwner,
  PluginInstanceInvocationPorts,
  PluginPreviewInstance,
} from "./instances.js";
import { ownedFileResources } from "./owned-file-resources.js";
import type {
  TurnAuthorizationIdentity,
  TurnAuthorizationScope,
} from "../../../shared/turn-authorization.js";

export type PluginOperation = {
  invocationId: string;
  origin: PluginInvocationOrigin;
  params: PluginToolCallParams;
  source?: { selector: PluginPreviewInstance["activation"]["selector"]; activationId: string };
};
const refused = () => new PluginInvocationError("INSTANCE_DENIED");
const native = (c: Context) =>
  !HOSTED_MODE && c.get("authMethod") === "authkit_jwt";
async function principal(
  c: Context,
): Promise<{ owner: TurnAuthorizationOwner; token: string } | undefined> {
  const token = (c.req.header("authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  );
  const verified = await verifyAuthKitToken(token, undefined, {
    allowMcpResourceAudience: true,
  });
  if (verified.sub !== c.get("workosUserId")) throw refused();
  if (!verified.sid) return undefined;
  return {
    token,
    owner: {
      subject: verified.sub,
      sessionId: verified.sid,
      organizationId: verified.orgId,
    },
  };
}
function scope(
  instance: PluginFormOwner,
  operation: PluginOperation,
  requestId: string,
): TurnAuthorizationScope {
  return {
    projectId: instance.owner.projectId,
    requestId,
    pluginOperation: {
      workspaceId: instance.owner.workspaceId,
      instanceId: instance.owner.instanceId,
      generation: instance.owner.generation,
      hostId: instance.hostId,
      serverId: instance.owner.serverId,
      invocationId: operation.invocationId,
      bindingHash: pluginBindingDigest([
        instance.owner.actorId,
        instance.owner.projectId,
        instance.owner.workspaceId,
        instance.owner.instanceId,
        instance.owner.generation,
        instance.owner.serverId,
        instance.owner.bindingId,
        instance.owner.placement,
        instance.subject,
        instance.hostId,
        instance.hostRevision,
        instance.serverIdentity,
        operation.origin,
        operation.source ?? null,
        sanitizePluginToolParams(operation.params),
      ]),
    },
  };
}

export function rootPluginOperation(
  instance: PluginPreviewInstance,
  input: {
    params?: PluginToolCallParams;
    invocationId?: string;
  },
  signal: AbortSignal,
): PluginOperation {
  if (input.params && !input.invocationId) throw refused();
  if (
    !input.params &&
    input.invocationId &&
    input.invocationId !== instance.activation.operationId
  )
    throw refused();
  return {
    origin: input.params
      ? "app"
      : instance.activation.selector.kind === "quick-action"
        ? "quick-action"
        : "entrypoint",
    invocationId: input.params
      ? input.invocationId!
      : instance.activation.operationId,
    source: { selector: instance.activation.selector, activationId: instance.activation.operationId },
    params: input.params ?? {
      name: instance.activation.toolName,
      arguments: instance.activation.file
        ? ownedFileResources.get(instance, signal).input
        : (instance.activation.arguments ?? {}),
    },
  };
}

/** Metadata only: the caller has already admitted the exact live owner. */
export async function preparePluginOperation(
  c: Context,
  instance: PluginFormOwner,
  operation: PluginOperation,
  requestId: string,
  signal: AbortSignal,
) {
  if (!native(c)) return undefined;
  const original = await principal(c);
  if (!original) return undefined;
  const { owner, token } = original;
  return {
    type: "data-turn-authorization" as const,
    transient: true,
    data: turnAuthorizations.prepareOperation(
      owner,
      scope(instance, operation, requestId),
      token,
      signal,
    ).data,
  };
}

/** One request borrows fresh same-owner auth. An unavailable supplied preflight only permits receipt recovery. */
export async function bindPluginOperation(
  c: Context,
  instance: PluginFormOwner,
  operation: PluginOperation,
  identity: TurnAuthorizationIdentity | undefined,
  signal: AbortSignal,
) {
  if (!native(c)) {
    const getBearer = await prepareBackgroundRequestAuthorization(c, instance.owner.projectId, { includeNativeApiKey: true, lazy: true });
    if (getBearer) setRequestLocal(c, "turnAuthorizationBearer", async () => (await getBearer()).replace(/^Bearer\s+/i, ""));
    return { receiptOnly: false, dispose() {} };
  }
  if (!identity) return { receiptOnly: false, dispose() {} };
  const original = await principal(c);
  if (!original) throw refused();
  const { owner } = original;
  const expected = {
    ...scope(instance, operation, identity.requestId),
    handle: identity.handle,
  };
  if (pluginBindingDigest(identity) !== pluginBindingDigest(expected))
    throw refused();
  const lease = turnAuthorizations.claimOperation(identity, owner, signal);
  if (!lease) return { receiptOnly: true, dispose() {} };
  setRequestLocal(c, "turnAuthorizationBearer", async () =>
    (await lease.getAuthorization()).replace(/^Bearer\s+/i, ""),
  );
  // Prime the same resolver used by admission and target authorization before dispatch.
  try {
    await getConvexBearerForRequest(c);
  } catch (error) {
    lease.dispose();
    throw error;
  }
  return { receiptOnly: false, dispose: lease.dispose };
}

export async function cancelPluginOperation(
  c: Context,
  identity: TurnAuthorizationIdentity,
  instance: PluginFormOwner,
) {
  if (
    !("pluginOperation" in identity) ||
    identity.projectId !== instance.owner.projectId ||
    identity.pluginOperation.instanceId !== instance.owner.instanceId ||
    identity.pluginOperation.generation !== instance.owner.generation
  )
    throw refused();
  if (!native(c)) return;
  const original = await principal(c);
  if (!original) throw refused();
  const { owner } = original;
  turnAuthorizations.cancelOperation(identity, owner);
}

/** Receipt recovery is allowed to read a prior outcome but cannot reach either wire leg. */
export function receiptOnlyPorts(
  ports: PluginInstanceInvocationPorts,
  receiptOnly: boolean,
): PluginInstanceInvocationPorts {
  if (!receiptOnly) return ports;
  return {
    ...ports,
    receiptOnly: true,
    execute: async () => {
      throw new PluginInvocationError("INVOCATION_OUTCOME_UNKNOWN", true);
    },
    ...(ports.continuation
      ? {
          continuation: {
            ...ports.continuation,
            resume: async () => {
              throw new PluginInvocationError(
                "INVOCATION_OUTCOME_UNKNOWN",
                true,
              );
            },
          },
        }
      : {}),
  };
}
