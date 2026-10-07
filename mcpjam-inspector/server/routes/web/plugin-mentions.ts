import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  isPluginMentionTool,
  pluginMentionToolUsesDefaultVisibility,
  parsePluginMentionItems,
  pluginMentionQuerySchema,
  PluginMentionError,
} from "../../../shared/plugin-mentions.js";
import { pluginMentionInstances } from "../../services/plugin-host/mention-instances.js";
import { createPluginRequestRuntime } from "../../services/plugin-host/request-runtime.js";
import { invokePluginRequest } from "../../services/plugin-host/request-invocation.js";
import { pluginToolCallValidation } from "../../services/plugin-host/tool-call-validation.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import type { PluginInstanceIdentity } from "../../services/plugin-host/instances.js";
import type { PluginWorkspaceAdmission } from "../../services/plugin-host/admission.js";
import { pluginDiagnostic } from "../../../shared/plugin-diagnostics.js";

const id = z.string().min(1).max(256);
const scopeSchema = z.strictObject({
  projectId: id,
  pluginWorkspace: z.unknown(),
});
const handleSchema = scopeSchema.extend({
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const openSchema = scopeSchema.extend({ hostId: id, serverId: id });
const searchSchema = handleSchema.extend({
  invocationId: z.string().uuid(),
  params: pluginMentionQuerySchema,
  approval: z
    .strictObject({ id: z.string().max(4096), approved: z.boolean() })
    .optional(),
});
/** Uses the parent route's identical admission, cleanup and error boundaries. */
export function pluginMentionRoutes(ports: {
  route: (c: Context, action: () => Promise<Response>) => Promise<Response>;
  admitted: (
    c: Context,
    body: z.infer<typeof scopeSchema>,
  ) => Promise<{
    actor: PluginInstanceIdentity;
    bearer: string;
    admission: PluginWorkspaceAdmission;
  }>;
  cleanup: (
    c: Context,
    body: z.infer<typeof scopeSchema>,
  ) => Promise<PluginInstanceIdentity>;
}) {
  const router = new Hono();
  router.post("/open", (c) =>
    ports.route(c, async () => {
      const body = openSchema.parse(await c.req.json());
      const { actor, bearer, admission } = await ports.admitted(c, body);
      const runtime = createPluginRequestRuntime(
        c,
        admission,
        bearer,
        body,
        undefined,
        { ownedForms: false },
      );
      try {
        const catalog = await runtime.catalog(c.req.raw.signal);
        // The client's mentions extension off: no @ search for this server.
        if (catalog.extensions?.capabilities.mentions === false)
          return c.json({ mention: null });
        const tools = catalog.tools.filter(isPluginMentionTool);
        if (!tools.length) return c.json({ mention: null });
        if (tools.length !== 1)
          throw new PluginMentionError("PLUGIN_MENTION_DECLARATION_AMBIGUOUS");
        const current = await runtime.resolve(tools[0]!.name, c.req.raw.signal);
        if (!isPluginMentionTool(current.tool))
          throw new PluginInvocationError("INSTANCE_DENIED");
        const opened = pluginMentionInstances.open(actor, {
          runtime: current.runtime,
          hostId: body.hostId,
          hostRevision: current.hostRevision,
          serverId: body.serverId,
          bindingId: current.bindingId,
          serverIdentity: current.serverIdentity,
          toolName: current.tool.name,
          revision: current.revision,
        });
        return c.json({
          mention: {
            instanceToken: opened.token,
            toolName: current.tool.name,
            title: current.tool.title ?? current.tool.name,
          },
          ...(pluginMentionToolUsesDefaultVisibility(current.tool)
            ? {
                diagnostics: [
                  {
                    ...pluginDiagnostic(
                      "info",
                      "PLUGIN_MENTION_DEFAULT_VISIBILITY",
                      `Mention tool "${current.tool.name}" has no ui.visibility`,
                      'The tool has no _meta.ui.visibility, so it uses the MCP Apps default ["model", "app"]. Declare it explicitly (mention search needs "app").',
                      { tool: current.tool.name },
                    ),
                    serverId: body.serverId,
                  },
                ],
              }
            : {}),
        });
      } finally {
        await runtime.release();
      }
    }),
  );
  router.post("/search", (c) =>
    ports.route(c, async () => {
      const body = searchSchema.parse(await c.req.json());
      const { actor, bearer, admission } = await ports.admitted(c, body);
      const lease = pluginMentionInstances.get(body.instanceToken, actor);
      const runtime = createPluginRequestRuntime(
        c,
        admission,
        bearer,
        { hostId: lease.hostId, serverId: lease.owner.serverId },
        lease,
        // The lease survives other toggles; turning mentions off refuses it.
        { ownedForms: false, extension: "mentions" },
      );
      return invokePluginRequest(c, {
        actor,
        owner: lease.owner,
        admission,
        runtime,
        resolve: runtime.resolve,
        assertOrigin: (resolved) => {
          if (
            !isPluginMentionTool(resolved.tool) ||
            resolved.tool.name !== lease.toolName ||
            resolved.revision !== lease.revision
          )
            throw new PluginInvocationError("INSTANCE_DENIED");
        },
        assertLive: () => {
          pluginMentionInstances.get(body.instanceToken, actor);
        },
        origin: "mention",
        invocationId: body.invocationId,
        params: { name: lease.toolName, arguments: body.params },
        approval: body.approval,
        validate: (resolved) => {
          const validate = pluginToolCallValidation(
            resolved.tool,
            body.params,
            () => new PluginMentionError("PLUGIN_MENTION_TOOL_INVALID"),
          );
          return (result) => {
            validate(result);
            parsePluginMentionItems(result);
          };
        },
        invoke: (invocationPorts) =>
          pluginMentionInstances.search(
            body.instanceToken,
            actor,
            invocationPorts,
            body.invocationId,
            body.params,
            c.req.raw.signal,
          ),
      });
    }),
  );
  router.post("/close", (c) =>
    ports.route(c, async () => {
      const body = handleSchema.parse(await c.req.json());
      pluginMentionInstances.close(
        body.instanceToken,
        await ports.cleanup(c, body),
      );
      return c.json({ status: "closed" });
    }),
  );
  return router;
}
