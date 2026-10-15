import { makeFunctionReference } from "convex/server";
import { createConvexClient } from "../evals/route-helpers.js";
import { readPluginExecutionContext } from "./admission.js";
import { pluginBindingDigest } from "./bindings.js";
import { PluginInvocationError } from "./invocation.js";
import { pluginOnboardingSpecSchema } from "../../../shared/plugin-onboarding.js";

/** Resolve from the original saved server, never a browser-provided version. */
export async function readServerOnboarding(options: {
  actorId: string;
  projectId: string;
  hostId: string;
  serverId: string;
  bearer: string;
  signal: AbortSignal;
  content: boolean;
}) {
  const read = () =>
    readPluginExecutionContext({
      projectId: options.projectId,
      expectedActorId: options.actorId,
      hostId: options.hostId,
      serverIds: [options.serverId],
      bearer: options.bearer,
      signal: options.signal,
    });
  const before = await read();
  const identity = before.serverBindings.get(options.serverId);
  if (identity?.kind !== "plugin") return { available: false as const };
  const client = createConvexClient(options.bearer);
  const detail = await client.query(
    makeFunctionReference<"query">("plugins:getPluginVersion"),
    { pluginVersionId: identity.pluginVersionId },
  );
  options.signal.throwIfAborted();
  const available = !!detail?.onboarding;
  const spec =
    available && options.content
      ? pluginOnboardingSpecSchema.parse(
          await client.query(
            makeFunctionReference<"query">("plugins:resolvePluginOnboarding"),
            {
              projectId: options.projectId,
              pluginVersionId: identity.pluginVersionId,
            },
          ),
        )
      : undefined;
  const after = await read();
  options.signal.throwIfAborted();
  if (
    pluginBindingDigest(before.hostConfig) !==
      pluginBindingDigest(after.hostConfig) ||
    pluginBindingDigest(identity) !==
      pluginBindingDigest(after.serverBindings.get(options.serverId)) ||
    (spec &&
      (spec.pluginId !== identity.pluginId ||
        spec.pluginVersionId !== identity.pluginVersionId ||
        spec.bundleHash !== identity.bundleHash))
  )
    throw new PluginInvocationError("INSTANCE_ONBOARDING_CHANGED");
  return { available, ...(spec ? { spec } : {}) };
}
