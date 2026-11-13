import { modelApps, readOwnedApp } from "./model-apps.js";
import { pluginResourceUri } from "./bindings.js";
import type { Context } from "hono";
import { z } from "zod";
import type { PluginModelContext } from "../../../shared/plugin-model-context.js";
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
  const contexts: PluginModelContext[] = [];
  const signal = input.c.req.raw.signal;
  for (const token of tokens) {
    const owned = await readOwnedApp(token, input.actor, signal);
    if (owned.kind === "model") {
      const record = owned.app;
      const runtime = createPluginRequestRuntime(
        input.c,
        input.admission,
        input.bearer,
        { hostId: record.owner.hostId, serverId: record.owner.owner.serverId },
        record.owner,
        { ownedForms: false },
      );
      try {
        const fresh = await runtime.resolve(record.toolName, signal);
        if (
          !fresh.contextEnabled ||
          fresh.revision !== record.revision ||
          pluginResourceUri(fresh.tool._meta) !== record.resourceUri
        )
          throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
        // The stored control beside admission: the context this turn reads
        // is the latest any replica wrote, from an App still open.
        await modelApps.fence(token, input.actor, signal)(() =>
          input.admission.revalidate({ signal }),
        );
        const current = modelApps.get(token, input.actor);
        const snapshot = current.context.snapshot(
          current.owner.owner.instanceId,
          current.owner.owner.generation,
        );
        if (snapshot.state)
          contexts.push({
            instanceId: current.owner.owner.instanceId,
            generation: current.owner.owner.generation,
            ...snapshot.state,
          });
      } finally {
        await runtime.release();
      }
      continue;
    }
    const instance = owned.instance;
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
        signal,
      );
      if (
        !current.contextEnabled ||
        current.revision !== instance.activation.revision
      )
        throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
      await input.admission.revalidate({ signal });
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
  signal.throwIfAborted();
  // A model App's control is shared by every replica, so one read before an
  // earlier token's later awaits proves nothing now: read those again. The
  // last token's fence was this turn's final await.
  await Promise.all(
    tokens
      .slice(0, -1)
      .filter((token) => modelApps.holds(token))
      .map((token) => modelApps.restore(token, input.actor, signal)),
  );
  // Every source remains live after the final authorization await.
  for (const token of tokens) {
    if (modelApps.holds(token)) modelApps.get(token, input.actor);
    else pluginInstances.get(token, input.actor);
  }
  // The turn budget is the chat's to apply, over every owner's contexts.
  return contexts;
}
