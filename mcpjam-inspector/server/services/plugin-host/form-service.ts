import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../evals/route-helpers.js";
import { waitForPluginOperation } from "../../../shared/plugin-operation.js";
import {
  compilePluginForm,
  ownedPluginFormProfile,
  pluginFormResources,
  pluginFormPreview,
  type PluginFormPreview,
  type PluginFormProfile,
} from "../../../shared/plugin-extensions/form-plan.js";
import { pluginBindingDigest } from "./bindings.js";
import { pluginFormSources, type PluginFormParent } from "./form-sources.js";
import { pluginInstances, type PluginInstanceIdentity } from "./instances.js";
import { PluginInvocationError } from "./invocation.js";
import type { createPluginRequestRuntime } from "./request-runtime.js";

const refuse = (): never => {
  throw new PluginInvocationError("FORM_PREVIEW_UNAVAILABLE");
};
const pendingQuery = makeFunctionReference<"query">(
  "pluginFormAnswers:authorizeServices",
);

export type PluginFormServiceOptions = {
  actor: PluginInstanceIdentity;
  bearer: string;
  sourceToken: string;
  parent: PluginFormParent;
  signal: AbortSignal;
  runtime: (
    instance: ReturnType<typeof pluginInstances.getFormOwner>,
  ) => ReturnType<typeof createPluginRequestRuntime>;
};
export type PluginFormPreviewServiceOptions = PluginFormServiceOptions & {
  target: PluginFormPreview;
};

/** Read-only authenticated pending fence; it confers no resource or execution grant. */
export async function assertPluginFormPending(options: {
  actor: Pick<PluginInstanceIdentity, "actorId">;
  bearer: string;
  source: import("./form-sources.js").PluginFormSource;
  sourceToken: string;
  signal: AbortSignal;
  chatSessionId?: string;
}) {
  const { source, signal } = options;
  signal.throwIfAborted();
  const fence: unknown = await waitForPluginOperation(signal, () =>
    createConvexClient(options.bearer).query(pendingQuery, {
      kind: source.parent.kind,
      id: source.parent.id,
      round: source.parent.round,
      projectId: source.owner.projectId,
      pluginWorkspaceId: source.owner.workspaceId,
      serverId: source.owner.serverId,
      sourceToken: options.sourceToken,
      ...(options.chatSessionId
        ? { chatSessionId: options.chatSessionId }
        : {}),
    }),
  );
  if (
    !fence ||
    typeof fence !== "object" ||
    (fence as { actorId?: unknown }).actorId !== options.actor.actorId ||
    typeof (fence as { expiresAt?: unknown }).expiresAt !== "number" ||
    !Number.isFinite((fence as { expiresAt: number }).expiresAt) ||
    (fence as { expiresAt: number }).expiresAt < source.expiresAt
  )
    refuse();
  signal.throwIfAborted();
}

/** Original source and live durable window shared by previews and uploads. No URI grant. */
export function createPluginFormAuthority(options: PluginFormServiceOptions) {
  const { source, signal: ownerSignal } = pluginFormSources.get(
    options.sourceToken,
    options.actor,
    options.parent,
  );
  const instance = pluginInstances.getFormOwner(source.owner, options.actor);
  const signal = AbortSignal.any([
    options.signal,
    ownerSignal,
    // Fresh saved authority and independent connection admission can require
    // several round trips. Bound the whole service request without shortening the
    // original pending window or cancelling a human wait.
    AbortSignal.timeout(30_000),
  ]);
  const runtime = options.runtime(instance);
  const checkPending = async () => {
    signal.throwIfAborted();
    pluginFormSources.get(options.sourceToken, options.actor, options.parent);
    pluginInstances.getFormOwner(source.owner, options.actor);
    await assertPluginFormPending({
      actor: options.actor,
      bearer: options.bearer,
      source,
      sourceToken: options.sourceToken,
      signal,
    });
    signal.throwIfAborted();
    pluginFormSources.get(options.sourceToken, options.actor, options.parent);
    pluginInstances.getFormOwner(source.owner, options.actor);
  };
  const authorize = async () => {
    await checkPending();
    const resolved = await waitForPluginOperation(signal, () =>
      runtime.resolve(source.toolName, signal),
    );
    if (
      resolved.revision !== source.revision ||
      resolved.hostRevision !== source.hostRevision ||
      resolved.bindingId !== source.owner.bindingId
    )
      refuse();
    signal.throwIfAborted();
    pluginFormSources.get(options.sourceToken, options.actor, options.parent);
    pluginInstances.getFormOwner(source.owner, options.actor);
    await checkPending();
    return resolved;
  };
  const authorizeTools = async (names: readonly string[]) => {
    await checkPending();
    const tools = await waitForPluginOperation(signal, () =>
      runtime.resolveTools([source.toolName, ...names], signal),
    );
    const original = tools.get(source.toolName);
    if (
      !original ||
      original.revision !== source.revision ||
      original.hostRevision !== source.hostRevision ||
      original.bindingId !== source.owner.bindingId
    )
      refuse();
    // The catalog admission checks every requested tool against one fresh
    // saved target. No metadata snapshot survives this service resolution.
    await checkPending();
    return tools;
  };
  const assertLive = () => {
    signal.throwIfAborted();
    pluginFormSources.get(options.sourceToken, options.actor, options.parent);
    pluginInstances.getFormOwner(source.owner, options.actor);
  };
  return {
    source,
    sourceSignal: ownerSignal,
    instance,
    signal,
    runtime,
    checkPending,
    authorize,
    authorizeTools,
    assertLive,
  };
}

export function createPluginFormService(
  options: PluginFormPreviewServiceOptions,
) {
  const service = createPluginFormAuthority(options);
  const profile = ownedPluginFormProfile(
    // The File resources toggle of the client that elicited this form.
    service.source.fileResources === true,
    service.source.origin === "app" ? "mcp-app" : "server",
    // Only which previews the form declares matters here. Whether this host
    // takes uploads is the file service's question; a form that also takes
    // uploads must still open its previews.
    true,
  );
  assertPluginFormPreviewDeclared(
    service.source.requestedSchema,
    profile,
    options.target,
  );
  return service;
}

/** Exact schema-declared target. Neither a URI nor presentation metadata is a grant. */
export function assertPluginFormPreviewDeclared(
  schema: unknown,
  profile: PluginFormProfile,
  target: PluginFormPreview,
) {
  const plan = compilePluginForm(schema, profile);
  if (
    !plan.fields.some(({ field }) =>
      pluginFormResources(field)?.options.some((resource) => {
        const preview = pluginFormPreview(resource);
        return (
          preview !== undefined &&
          pluginBindingDigest(preview) === pluginBindingDigest(target)
        );
      }),
    )
  )
    refuse();
}
