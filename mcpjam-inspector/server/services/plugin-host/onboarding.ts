import { makeFunctionReference } from "convex/server";
import { z } from "zod";
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

const id = z.string().min(1).max(256);
const requestBase = {
  projectId: id,
  pluginWorkspace: z.unknown(),
  content: z.boolean(),
};
/** One plugin server's onboarding, or the plugin's own when it has none. */
export const onboardingRequestSchema = z.union([
  z.strictObject({ ...requestBase, hostId: id, serverId: id }),
  z.strictObject({ ...requestBase, pluginId: id }),
]);

export function readOnboarding(
  request: z.infer<typeof onboardingRequestSchema>,
  { actorId }: { actorId: string },
  bearer: string,
  signal: AbortSignal,
) {
  const { projectId, content } = request;
  return "serverId" in request
    ? readServerOnboarding({ ...request, actorId, bearer, signal })
    : readPluginOnboarding({
        projectId,
        pluginId: request.pluginId,
        bearer,
        signal,
        content,
      });
}

const activePluginsReplySchema = z.object({
  enabled: z.boolean(),
  plugins: z
    .array(
      z.object({
        pluginId: z.string(),
        pluginVersionId: z.string().nullish(),
        status: z.string(),
        servers: z.array(z.unknown()),
      }),
    )
    .optional(),
});

/**
 * A plugin with no server, which has no saved server to resolve from. Its
 * version is the one this member's next turn would run, read here, never a
 * browser-provided one. A plugin with servers onboards through one of them.
 */
export async function readPluginOnboarding(options: {
  projectId: string;
  pluginId: string;
  bearer: string;
  signal: AbortSignal;
  content: boolean;
}) {
  const client = createConvexClient(options.bearer);
  const activeVersion = async () => {
    const reply = activePluginsReplySchema.parse(
      await client.query(
        makeFunctionReference<"query">("plugins:resolveActivePlugins"),
        { projectId: options.projectId, content: false },
      ),
    );
    options.signal.throwIfAborted();
    const row = reply.enabled
      ? reply.plugins?.find((plugin) => plugin.pluginId === options.pluginId)
      : undefined;
    return row?.status === "active" && row.servers.length === 0
      ? (row.pluginVersionId ?? null)
      : null;
  };
  const pluginVersionId = await activeVersion();
  if (!pluginVersionId) return { available: false as const };
  const detail = await client.query(
    makeFunctionReference<"query">("plugins:getPluginVersion"),
    { pluginVersionId },
  );
  options.signal.throwIfAborted();
  const available = !!detail?.onboarding;
  const spec =
    available && options.content
      ? pluginOnboardingSpecSchema.parse(
          await client.query(
            makeFunctionReference<"query">("plugins:resolvePluginOnboarding"),
            { projectId: options.projectId, pluginVersionId },
          ),
        )
      : undefined;
  if (
    (await activeVersion()) !== pluginVersionId ||
    (spec &&
      (spec.pluginId !== options.pluginId ||
        spec.pluginVersionId !== pluginVersionId))
  )
    throw new PluginInvocationError("INSTANCE_ONBOARDING_CHANGED");
  return { available, ...(spec ? { spec } : {}) };
}
