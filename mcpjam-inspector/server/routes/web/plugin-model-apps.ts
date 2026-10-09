import { Hono, type Context } from "hono";
import { z } from "zod";
import { pluginModelContextParamsSchema } from "../../../shared/plugin-model-context.js";
import { getToolVisibility } from "@mcpjam/sdk/widget-runtime";
import type { PluginInstanceIdentity } from "../../services/plugin-host/instances.js";
import type { PluginWorkspaceAdmission } from "../../services/plugin-host/admission.js";
import { modelApps } from "../../services/plugin-host/model-apps.js";
import { createPluginRequestRuntime } from "../../services/plugin-host/request-runtime.js";
import { invokePluginRequest } from "../../services/plugin-host/request-invocation.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import { pluginResourceUri } from "../../services/plugin-host/bindings.js";
import { widgetResourceContent } from "../../utils/widget-resource-content.js";
import {
  canSkipListingLookup,
  findListingMetaForUri,
} from "../../utils/ui-resource-meta.js";
import { viewOriginLabelForConfig } from "../../utils/view-origin-label.js";
const scope = z.strictObject({
  projectId: z.string().min(1).max(256),
  pluginWorkspace: z.unknown(),
});
const handle = scope.extend({
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const call = handle.extend({
  invocationId: z.string().uuid(),
  params: z.strictObject({
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.unknown()),
  }),
  approval: z
    .strictObject({ id: z.string().max(4096), approved: z.boolean() })
    .optional(),
});
const denied = () => new PluginInvocationError("MODEL_APP_UNAVAILABLE");
export function pluginModelAppRoutes(ports: {
  route: (c: Context, action: () => Promise<Response>) => Promise<Response>;
  admitted: (
    c: Context,
    body: z.infer<typeof scope>,
  ) => Promise<{
    actor: PluginInstanceIdentity;
    bearer: string;
    admission: PluginWorkspaceAdmission;
  }>;
  cleanup: (
    c: Context,
    body: z.infer<typeof scope>,
  ) => Promise<PluginInstanceIdentity>;
}) {
  const router = new Hono();
  router.post("/open", (c) =>
    ports.route(c, async () => {
      const body = handle.parse(await c.req.json());
      const { actor, bearer, admission } = await ports.admitted(c, body);
      const record = modelApps.get(body.instanceToken, actor);
      const runtime = createPluginRequestRuntime(
        c,
        admission,
        bearer,
        { hostId: record.owner.hostId, serverId: record.owner.owner.serverId },
        record.owner,
        { ownedForms: false },
      );
      const signal = AbortSignal.any([c.req.raw.signal, record.abort.signal]);
      try {
        const source = await runtime.resolve(record.toolName, signal);
        if (
          source.revision !== record.revision ||
          pluginResourceUri(source.tool._meta) !== record.resourceUri
        )
          throw denied();
        const resource = await source.manager.readResource(
          record.owner.owner.serverId,
          { uri: record.resourceUri },
          { signal },
        );
        const content = resource.contents.find(
          (item: { uri: string }) => item.uri === record.resourceUri,
        );
        const listingMeta = canSkipListingLookup(content?._meta)
          ? undefined
          : await findListingMetaForUri(
              source.manager,
              record.owner.owner.serverId,
              record.resourceUri,
            );
        const widgetContent = widgetResourceContent(content, listingMeta);
        if (
          !widgetContent.mimeTypeValid ||
          Buffer.byteLength(widgetContent.html) > 1024 * 1024
        )
          throw denied();
        const fresh = await runtime.resolve(record.toolName, signal);
        if (fresh.revision !== record.revision) throw denied();
        await admission.revalidate({ signal });
        modelApps.get(body.instanceToken, actor);
        signal.throwIfAborted();
        return c.json({
          instanceToken: body.instanceToken,
          instanceId: record.owner.owner.instanceId,
          generation: 1,
          operationId: record.owner.owner.instanceId,
          resourceUri: record.resourceUri,
          toolTitle: source.tool.title ?? source.tool.name,
          toolMetadata: source.tool._meta,
          appToolsEnabled: fresh.appToolsEnabled,
          contextEnabled: fresh.contextEnabled,
          messageEnabled: fresh.messageEnabled,
          contextSnapshot: record.context.snapshot(
            record.owner.owner.instanceId,
            record.owner.owner.generation,
          ),
          widgetContent: {
            ...widgetContent,
            permissive: false,
            injectedOpenAiCompat: false,
            viewOriginLabel: viewOriginLabelForConfig(
              source.manager.getServerConfig(record.owner.owner.serverId),
            ),
          },
        });
      } finally {
        await runtime.release();
      }
    }),
  );
  // Model Apps use their original immutable source, never a replacement instance.
  for (const action of ["update", "read", "remove"] as const) {
    router.post(action === "update" ? "/context" : `/context/${action}`, (c) =>
      ports.route(c, async () => {
        const raw = await c.req.json();
        const schema =
          action === "update"
            ? handle.extend({
                operationId: z.string().uuid(),
                sequence: z.number().int().positive(),
                params: pluginModelContextParamsSchema,
                attach: z.literal("user").optional(),
              })
            : action === "remove"
            ? handle.extend({
                operationId: z.string().uuid(),
                updateId: z.string().uuid(),
                index: z.number().int().nonnegative(),
              })
            : handle;
        const body = schema.parse(raw);
        const { actor, bearer, admission } = await ports.admitted(c, body);
        const record = modelApps.get(body.instanceToken, actor);
        const runtime = createPluginRequestRuntime(
          c,
          admission,
          bearer,
          {
            hostId: record.owner.hostId,
            serverId: record.owner.owner.serverId,
          },
          record.owner,
          { ownedForms: false },
        );
        const signal = AbortSignal.any([c.req.raw.signal, record.abort.signal]);
        try {
          const fresh = await runtime.resolve(record.toolName, signal);
          if (
            !fresh.contextEnabled ||
            fresh.revision !== record.revision ||
            pluginResourceUri(fresh.tool._meta) !== record.resourceUri
          )
            throw denied();
          await admission.revalidate({ signal });
          modelApps.get(body.instanceToken, actor);
          signal.throwIfAborted();
          const id = record.owner.owner.instanceId;
          const generation = record.owner.owner.generation;
          // All admission awaits finish before this synchronous, bounded mutation.
          if (action === "read")
            return c.json(record.context.snapshot(id, generation));
          if (action === "remove")
            return c.json(
              record.context.remove(id, generation, {
                operationId: raw.operationId,
                updateId: raw.updateId,
                index: raw.index,
              }),
            );
          const result = record.context.update(id, generation, {
            operationId: raw.operationId,
            sequence: raw.sequence,
            params: raw.params,
            ...(raw.attach === "user" ? { attach: "user" as const } : {}),
          });
          return c.json({
            ...result,
            snapshot: record.context.snapshot(id, generation),
          });
        } finally {
          await runtime.release();
        }
      }),
    );
  }
  router.post("/call", (c) =>
    ports.route(c, async () => {
      const body = call.parse(await c.req.json());
      const { actor, bearer, admission } = await ports.admitted(c, body);
      const record = modelApps.get(body.instanceToken, actor);
      const runtime = createPluginRequestRuntime(
        c,
        admission,
        bearer,
        { hostId: record.owner.hostId, serverId: record.owner.owner.serverId },
        record.owner,
        { ownedForms: false },
      );
      return await invokePluginRequest(c, {
        actor,
        owner: record.owner.owner,
        admission,
        runtime,
        origin: "app",
        invocationId: body.invocationId,
        params: body.params,
        approval: body.approval,
        assertLive: () => {
          modelApps.get(body.instanceToken, actor);
        },
        resolve: async (name, signal, read) => {
          // Source and requested tool must come from the same freshly authorized
          // catalog. Resolving them separately doubles every admission fence.
          const tools = await runtime.resolveTools(
            [record.toolName, name],
            signal,
            read,
          );
          const source = tools.get(record.toolName)!;
          if (
            source.revision !== record.revision ||
            pluginResourceUri(source.tool._meta) !== record.resourceUri
          )
            throw denied();
          return tools.get(name)!;
        },
        assertOrigin: (resolved) => {
          if (
            !resolved.appToolsEnabled ||
            !getToolVisibility(resolved.tool._meta).includes("app")
          )
            throw denied();
        },
        invoke: (invocationPorts, params) =>
          record.invoker.invoke(
            invocationPorts,
            "app",
            body.invocationId,
            params,
            AbortSignal.any([c.req.raw.signal, record.abort.signal]),
          ),
      });
    }),
  );
  router.post("/renew", (c) =>
    ports.route(c, async () => {
      const body = handle.parse(await c.req.json());
      const { actor } = await ports.admitted(c, body);
      return c.json({
        status: "renewed",
        expiresAt: modelApps.renew(body.instanceToken, actor),
      });
    }),
  );
  router.post("/close", (c) =>
    ports.route(c, async () => {
      const body = handle.parse(await c.req.json());
      modelApps.close(body.instanceToken, await ports.cleanup(c, body));
      return c.json({ closed: true });
    }),
  );
  return router;
}
