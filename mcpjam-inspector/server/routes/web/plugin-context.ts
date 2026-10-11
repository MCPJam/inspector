import { Hono, type Context } from "hono";
import { z } from "zod";
import { pluginModelContextParamsSchema } from "../../../shared/plugin-model-context.js";
import {
  pluginInstances,
  type PluginInstanceIdentity,
} from "../../services/plugin-host/instances.js";
import type { PluginWorkspaceAdmission } from "../../services/plugin-host/admission.js";
import { createPluginRequestRuntime } from "../../services/plugin-host/request-runtime.js";
import { resolveOpenPluginActivation } from "../../services/plugin-host/activation.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
const handle = z.strictObject({
  projectId: z.string().min(1).max(256),
  pluginWorkspace: z.unknown(),
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const change = handle.extend({
  operationId: z.string().uuid(),
  sequence: z.number().int().positive(),
  params: pluginModelContextParamsSchema,
  /** The person was using the App when it sent this update. */
  attach: z.literal("user").optional(),
});
const removal = handle.extend({
  operationId: z.string().uuid(),
  updateId: z.string().uuid(),
  index: z.number().int().nonnegative(),
});
export function pluginContextRoutes(ports: {
  route: (c: Context, action: () => Promise<Response>) => Promise<Response>;
  admitted: (
    c: Context,
    body: z.infer<typeof handle>,
  ) => Promise<{
    actor: PluginInstanceIdentity;
    bearer: string;
    admission: PluginWorkspaceAdmission;
  }>;
}) {
  const router = new Hono();
  async function use(
    c: Context,
    body: z.infer<typeof handle>,
    action: (
      actor: PluginInstanceIdentity,
      authorize: () => Promise<void>,
    ) => Promise<Response>,
  ) {
    const { actor, bearer, admission } = await ports.admitted(c, body);
    const instance = await pluginInstances.getPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
    );
    if (!instance.contextEnabled)
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
      { ownedForms: false },
    );
    const authorize = async () => {
      const resolved = await resolveOpenPluginActivation(
        runtime,
        instance.activation,
        c.req.raw.signal,
      );
      // The client's current toggle, not the one the App opened with.
      if (resolved.extensions?.capabilities.modelContext === false)
        throw new PluginInvocationError("PLUGIN_EXTENSION_DISABLED");
      if (
        !resolved.contextEnabled ||
        resolved.revision !== instance.activation.revision
      )
        throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
      await admission.revalidate({ signal: c.req.raw.signal });
      pluginInstances.get(body.instanceToken, actor);
    };
    try {
      await authorize();
      return await action(actor, authorize);
    } finally {
      await runtime.release();
    }
  }
  router.post("/", (c) =>
    ports.route(c, async () => {
      const body = change.parse(await c.req.json());
      return use(c, body, async (actor, authorize) => {
        const changed = await pluginInstances.changeContextPersistent(
          body.instanceToken,
          actor,
          { kind: "update", request: body },
          c.req.raw.signal,
          authorize,
        );
        return c.json({ ...changed.result, snapshot: changed.snapshot });
      });
    }),
  );
  router.post("/read", (c) =>
    ports.route(c, async () => {
      const body = handle.parse(await c.req.json());
      return use(c, body, async (actor, authorize) => {
        await authorize();
        return c.json(
          pluginInstances.contextSnapshot(body.instanceToken, actor),
        );
      });
    }),
  );
  router.post("/remove", (c) =>
    ports.route(c, async () => {
      const body = removal.parse(await c.req.json());
      return use(c, body, async (actor, authorize) => {
        const changed = await pluginInstances.changeContextPersistent(
          body.instanceToken,
          actor,
          { kind: "remove", request: body },
          c.req.raw.signal,
          authorize,
        );
        return c.json(changed.snapshot);
      });
    }),
  );
  return router;
}
