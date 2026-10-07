import { modelApps } from "./model-apps.js";
import { pluginResourceUri } from "./bindings.js";
import type { Context } from "hono";
import { z } from "zod";
import { pluginModelContextMessage } from "../../../shared/plugin-model-context.js";
import type { PluginWorkspaceAdmission } from "./admission.js";
import { pluginInstances, type PluginInstanceIdentity } from "./instances.js";
import { createPluginRequestRuntime } from "./request-runtime.js";
import { resolveOpenPluginActivation } from "./activation.js";
import { PluginInvocationError } from "./invocation.js";

export const pluginContextReferencesSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{43}$/))
  .max(64);
/** The browser sends handles, never authoritative App context bytes. No resource reads. */
export async function readOwnedTurnContext(input: {
  c: Context;
  references: unknown;
  actor: PluginInstanceIdentity;
  bearer: string;
  admission: PluginWorkspaceAdmission;
}) {
  const tokens = [
    ...new Set(pluginContextReferencesSchema.parse(input.references)),
  ];
  const contexts = [];
  for (const token of tokens) {
    if (modelApps.has(token)) {
      const record = modelApps.get(token, input.actor);
      const runtime = createPluginRequestRuntime(
        input.c,
        input.admission,
        input.bearer,
        { hostId: record.owner.hostId, serverId: record.owner.owner.serverId },
        record.owner,
        { ownedForms: false },
      );
      try {
        const fresh = await runtime.resolve(
          record.toolName,
          input.c.req.raw.signal,
        );
        if (
          !fresh.contextEnabled ||
          fresh.revision !== record.revision ||
          pluginResourceUri(fresh.tool._meta) !== record.resourceUri
        )
          throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
        await input.admission.revalidate({ signal: input.c.req.raw.signal });
        modelApps.get(token, input.actor);
        const snapshot = record.context.snapshot(
          record.owner.owner.instanceId,
          record.owner.owner.generation,
        );
        if (snapshot.state)
          contexts.push({
            instanceId: record.owner.owner.instanceId,
            generation: record.owner.owner.generation,
            ...snapshot.state,
          });
      } finally {
        await runtime.release();
      }
      continue;
    }
    const instance = await pluginInstances.getPersistent(
      token,
      input.actor,
      input.c.req.raw.signal,
    );
    if (!instance.contextEnabled)
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    const runtime = createPluginRequestRuntime(
      input.c,
      input.admission,
      input.bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
      { ownedForms: false },
    );
    try {
      const current = await resolveOpenPluginActivation(
        runtime,
        instance.activation,
        input.c.req.raw.signal,
      );
      if (
        !current.contextEnabled ||
        current.revision !== instance.activation.revision
      )
        throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
      await input.admission.revalidate({ signal: input.c.req.raw.signal });
      pluginInstances.get(token, input.actor);
      const snapshot = pluginInstances.contextSnapshot(token, input.actor);
      if (snapshot.state)
        contexts.push({
          instanceId: instance.owner.instanceId,
          generation: instance.owner.generation,
          ...snapshot.state,
        });
    } finally {
      await runtime.release();
    }
  }
  input.c.req.raw.signal.throwIfAborted();
  // Every source remains live after the final authorization await.
  for (const token of tokens) {
    if (modelApps.has(token)) modelApps.get(token, input.actor);
    else pluginInstances.get(token, input.actor);
  }
  return pluginModelContextMessage(contexts);
}
