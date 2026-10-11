import { randomBytes } from "node:crypto";
import { getToolVisibility } from "@mcpjam/sdk/widget-runtime";
import { pluginResourceUri } from "../../services/plugin-host/bindings.js";
import { widgetResourceContent } from "../../utils/widget-resource-content.js";
import {
  canSkipListingLookup,
  findListingMetaForUri,
} from "../../utils/ui-resource-meta.js";
import { pluginToolCallValidation } from "../../services/plugin-host/tool-call-validation.js";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import {
  admitPluginWorkspace,
  resolvePluginCleanupActor,
  PluginWorkspaceAdmissionError,
} from "../../services/plugin-host/admission.js";
import {
  type PluginInstanceAdmissionRead,
  pluginInstances,
} from "../../services/plugin-host/instances.js";
import {
  createPluginRequestRuntime,
  resolvePluginCatalogTool,
} from "../../services/plugin-host/request-runtime.js";
import { invokePluginRequest } from "../../services/plugin-host/request-invocation.js";
import {
  resolvePluginSettingsCatalog,
  settingsActionBindings,
  settingsActionToolValidation,
  settingsToolValidation,
} from "../../services/plugin-host/settings-catalog.js";
import {
  parsePluginSettingsDocument,
  parsePluginSettingsUpdate,
  parsePluginSettingsSet,
  PluginSettingsError,
  type PluginSettingsDocument,
} from "../../../shared/plugin-settings.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { toolApprovalSubjectFromAuthHeader } from "../../utils/tool-approval-token.js";
import {
  describePluginError,
  pluginErrorDiagnostic,
} from "../../../shared/plugin-diagnostics.js";
const scope = z.strictObject({
  projectId: z.string().min(1),
  pluginWorkspace: z.strictObject({
    version: z.literal(1),
    workspaceId: z.string().min(1),
  }),
});
const server = scope.extend({
  hostId: z.string().min(1),
  serverId: z.string().min(1),
});
const handle = scope.extend({ instanceToken: z.string().min(1) });
const invocation = handle.extend({
  operationId: z.string().uuid(),
  set: z.record(z.string(), z.unknown()).optional(),
  toolName: z.string().optional(),
  approval: z.object({ id: z.string(), approved: z.boolean() }).optional(),
});
const children = new Map<
  string,
  { parent: string; action: string; revision: string; dispose: () => void }
>();
const childHandle = handle.extend({ childToken: z.string().min(1) });
const documents = new Map<string, PluginSettingsDocument>();
const observed = new Set<string>();
const denied = () => new PluginInvocationError("INSTANCE_DENIED");
async function identity(c: Context, body: z.infer<typeof scope>) {
  const bearer = await getConvexBearerForRequest(c);
  const subject = toolApprovalSubjectFromAuthHeader(
    c.req.header("authorization"),
  );
  if (subject === "anonymous") throw denied();
  const admission = await admitPluginWorkspace({
    projectId: body.projectId,
    descriptor: body.pluginWorkspace,
    bearer,
    signal: c.req.raw.signal,
  });
  return {
    bearer,
    admission,
    actor: {
      actorId: admission.actorId,
      projectId: body.projectId,
      workspaceId: body.pluginWorkspace.workspaceId,
      subject,
    },
  };
}
/** Errors carry a plain-English description; server-author mistakes in the
 * settings declaration also carry a Logs diagnostic. */
const failure = (code: string, serverId?: string) => {
  const description = describePluginError(code);
  return {
    code,
    ...(description ? { description } : {}),
    ...(code.startsWith("PLUGIN_SETTINGS_") && serverId
      ? {
          diagnostics: [
            {
              ...pluginErrorDiagnostic(code, "Settings unavailable"),
              serverId,
            },
          ],
        }
      : {}),
  };
};
async function route(c: Context, run: () => Promise<Response>) {
  let serverId: string | undefined;
  try {
    serverId = await c.req
      .raw.clone()
      .json()
      .then((value: { serverId?: unknown }) =>
        typeof value?.serverId === "string" ? value.serverId : undefined,
      )
      .catch(() => undefined);
    return await run();
  } catch (error) {
    if (error instanceof z.ZodError)
      return c.json(failure("SETTINGS_REQUEST_INVALID"), 400);
    if (error instanceof PluginWorkspaceAdmissionError)
      return c.json(failure("SETTINGS_UNAVAILABLE"), 403);
    if (
      error instanceof PluginInvocationError ||
      error instanceof PluginSettingsError
    )
      return c.json(failure(error.code, serverId), 403);
    return c.json(failure("SETTINGS_UNAVAILABLE"), 503);
  }
}
const routes = new Hono();
routes.post("/discover", (c) =>
  route(c, async () => {
    const body = server.parse(await c.req.json());
    const { bearer, admission } = await identity(c, body);
    const runtime = createPluginRequestRuntime(c, admission, bearer, body);
    try {
      const catalog = await runtime.catalog(c.req.raw.signal);
      // The client's settings extension off: no settings for this server.
      const resolved =
        catalog.extensions?.capabilities.settings === false
          ? undefined
          : resolvePluginSettingsCatalog(catalog);
      return c.json({
        settings: resolved?.settings ?? null,
        ...(resolved?.diagnostics.length
          ? {
              diagnostics: resolved.diagnostics.map((diagnostic) => ({
                ...diagnostic,
                serverId: body.serverId,
              })),
            }
          : {}),
      });
    } finally {
      await runtime.release();
    }
  }),
);
routes.post("/open", (c) =>
  route(c, async () => {
    const body = server.parse(await c.req.json());
    const { bearer, admission, actor } = await identity(c, body);
    const runtime = createPluginRequestRuntime(c, admission, bearer, body);
    try {
      const catalog = await runtime.catalog(c.req.raw.signal);
      if (catalog.extensions?.capabilities.settings === false)
        throw new PluginInvocationError("PLUGIN_EXTENSION_DISABLED");
      const binding = resolvePluginSettingsCatalog(catalog);
      if (!binding) throw denied();
      const read = resolvePluginCatalogTool(catalog, binding.settings.readTool);
      const opened = await pluginInstances.openActivationPersistent(
        actor,
        {
          runtime: catalog.runtime,
          hostId: body.hostId,
          hostRevision: catalog.hostRevision,
          serverId: body.serverId,
          bindingId: catalog.bindingId,
          serverIdentity: catalog.serverIdentity,
          resourceUri: "ui://mcpjam/structured-settings",
          activation: {
            selector: { kind: "settings" },
            toolName: binding.settings.readTool,
            revision: read.revision,
            settings: {
              readTool: binding.settings.readTool,
              updateTool: binding.settings.updateTool,
              revision: binding.revision,
            },
          },
        },
        c.req.raw.signal,
      );
      if (!observed.has(opened.token)) {
        observed.add(opened.token);
        pluginInstances.signal(opened.token, actor).addEventListener(
          "abort",
          () => {
            documents.delete(opened.token);
            observed.delete(opened.token);
          },
          { once: true },
        );
      }
      return c.json({ instanceToken: opened.token, ...binding.settings });
    } finally {
      await runtime.release();
    }
  }),
);
for (const method of ["read", "update", "action"] as const)
  routes.post(`/${method}`, (c) =>
    route(c, async () => {
      const body = invocation.parse(await c.req.json());
      const { bearer, admission, actor } = await identity(c, body);
      const instance = await pluginInstances.getPersistent(
        body.instanceToken,
        actor,
        c.req.raw.signal,
      );
      const settings = instance.activation.settings;
      if (!settings) throw denied();
      let document = documents.get(body.instanceToken);
      const name =
        method === "read"
          ? settings.readTool
          : method === "update"
          ? settings.updateTool
          : body.toolName!;
      if (!name || (method !== "read" && !document)) throw denied();
      const args =
        method === "update"
          ? parsePluginSettingsSet(document!.fields, { set: body.set })
          : {};
      const runtime = createPluginRequestRuntime(
        c,
        admission,
        bearer,
        { hostId: instance.hostId, serverId: instance.owner.serverId },
        instance,
      );
      let catalog: Awaited<ReturnType<typeof runtime.catalog>>;
      const resolve = async (
        toolName: string,
        signal: AbortSignal,
        read?: PluginInstanceAdmissionRead,
      ) => {
        catalog = await runtime.catalog(signal, read);
        const current = resolvePluginSettingsCatalog(catalog);
        if (!current || current.revision !== settings.revision) throw denied();
        if (
          method === "action" &&
          !settingsActionBindings(document!, catalog).some(
            (action) => action.name === name && action.kind !== "unavailable",
          )
        )
          throw denied();
        return resolvePluginCatalogTool(catalog, toolName);
      };
      return await invokePluginRequest(c, {
        actor,
        owner: instance.owner,
        admission,
        runtime,
        resolve,
        origin: "settings",
        invocationId: body.operationId,
        params: { name, arguments: args },
        approval: body.approval,
        assertLive: () => {
          pluginInstances.get(body.instanceToken, actor);
        },
        assertOrigin: () => {},
        validate: (resolved) => {
          const validate =
            method === "action"
              ? settingsActionToolValidation(resolved.tool)
              : settingsToolValidation(resolved.tool, args);
          return (result) => {
            validate(result);
            const content =
              mcpAppToolResultSchema.parse(result).structuredContent;
            if (method === "read") {
              document = parsePluginSettingsDocument(content);
              documents.set(body.instanceToken, document);
            } else if (method === "update") {
              const values = parsePluginSettingsUpdate(
                document!.fields,
                content,
              );
              documents.set(body.instanceToken, { ...document!, values });
            }
          };
        },
        invoke: (ports, params) =>
          pluginInstances.invoke(
            body.instanceToken,
            actor,
            ports,
            body.operationId,
            params,
            c.req.raw.signal,
            "settings",
          ),
      });
    }),
  );
routes.post("/actions", (c) =>
  route(c, async () => {
    const body = handle.parse(await c.req.json());
    const { bearer, admission, actor } = await identity(c, body);
    const instance = await pluginInstances.getPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
    );
    const settings = instance.activation.settings;
    const document = documents.get(body.instanceToken);
    if (!settings || !document) throw denied();
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
    );
    try {
      const catalog = await runtime.catalog(c.req.raw.signal);
      if (resolvePluginSettingsCatalog(catalog)?.revision !== settings.revision)
        throw denied();
      return c.json({
        actions: settingsActionBindings(document, catalog).map(
          ({ name, kind }) => ({ name, kind }),
        ),
      });
    } finally {
      await runtime.release();
    }
  }),
);
routes.post("/close", (c) =>
  route(c, async () => {
    const body = handle.parse(await c.req.json());
    const bearer = await getConvexBearerForRequest(c);
    const subject = toolApprovalSubjectFromAuthHeader(
      c.req.header("authorization"),
    );
    if (subject === "anonymous") throw denied();
    const actorId = await resolvePluginCleanupActor({
      bearer,
      signal: c.req.raw.signal,
    });
    await pluginInstances.closePersistent(
      body.instanceToken,
      {
        actorId,
        projectId: body.projectId,
        workspaceId: body.pluginWorkspace.workspaceId,
        subject,
      },
      c.req.raw.signal,
    );
    documents.delete(body.instanceToken);
    return c.json({ ok: true });
  }),
);
routes.post("/app/open", (c) =>
  route(c, async () => {
    const body = handle
      .extend({ toolName: z.string().min(1) })
      .parse(await c.req.json());
    const { bearer, admission, actor } = await identity(c, body);
    const instance = await pluginInstances.getPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
    );
    const document = documents.get(body.instanceToken);
    if (!document || !instance.activation.settings) throw denied();
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
    );
    try {
      const catalog = await runtime.catalog(c.req.raw.signal);
      if (
        resolvePluginSettingsCatalog(catalog)?.revision !==
        instance.activation.settings.revision
      )
        throw denied();
      const action = settingsActionBindings(document, catalog).find(
        (item) => item.name === body.toolName && item.kind === "app",
      );
      if (!action) throw denied();
      const tool = resolvePluginCatalogTool(catalog, body.toolName).tool;
      const uri = pluginResourceUri(tool._meta);
      const resource = await catalog.manager.readResource(
        instance.owner.serverId,
        { uri },
        { signal: c.req.raw.signal },
      );
      const content = resource.contents.find((item) => item.uri === uri);
      const meta = canSkipListingLookup(content?._meta)
        ? undefined
        : await findListingMetaForUri(
            catalog.manager,
            instance.owner.serverId,
            uri,
          );
      const widgetContent = widgetResourceContent(content, meta);
      if (
        !widgetContent.mimeTypeValid ||
        Buffer.byteLength(widgetContent.html) > 1024 * 1024
      )
        throw denied();
      const fresh = await runtime.catalog(c.req.raw.signal);
      if (
        resolvePluginSettingsCatalog(fresh)?.revision !==
          instance.activation.settings.revision ||
        !settingsActionBindings(document, fresh).some(
          (item) =>
            item.name === body.toolName && item.revision === action.revision,
        )
      )
        throw denied();
      await pluginInstances.getPersistent(
        body.instanceToken,
        actor,
        c.req.raw.signal,
      );
      if (
        children.size >= 128 ||
        [...children.values()].filter(
          (child) => child.parent === body.instanceToken,
        ).length >= 8
      )
        throw denied();
      const childToken = randomBytes(32).toString("base64url");
      const signal = pluginInstances.signal(body.instanceToken, actor);
      const dispose = () => {
        children.delete(childToken);
        signal.removeEventListener("abort", dispose);
        clearTimeout(timer);
      };
      const timer = setTimeout(dispose, 30 * 60_000);
      timer.unref?.();
      children.set(childToken, {
        parent: body.instanceToken,
        action: body.toolName,
        revision: action.revision,
        dispose,
      });
      signal.addEventListener("abort", dispose, { once: true });
      return c.json({
        childToken,
        resourceUri: uri,
        widgetContent,
        toolMetadata: tool._meta,
        appToolsEnabled: fresh.appToolsEnabled,
      });
    } finally {
      await runtime.release();
    }
  }),
);
routes.post("/app/call", (c) =>
  route(c, async () => {
    const body = childHandle
      .extend({
        operationId: z.string().uuid(),
        params: z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()),
        }),
        approval: z
          .object({ id: z.string(), approved: z.boolean() })
          .optional(),
      })
      .parse(await c.req.json());
    const { bearer, admission, actor } = await identity(c, body);
    const instance = await pluginInstances.getPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
    );
    const child = children.get(body.childToken);
    const document = documents.get(body.instanceToken);
    if (
      !child ||
      child.parent !== body.instanceToken ||
      !document ||
      !instance.activation.settings
    )
      throw denied();
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
    );
    const live = () => {
      if (children.get(body.childToken) !== child) throw denied();
      pluginInstances.get(body.instanceToken, actor);
    };
    return await invokePluginRequest(c, {
      actor,
      owner: instance.owner,
      admission,
      runtime,
      origin: "app",
      invocationId: body.operationId,
      params: body.params,
      approval: body.approval,
      resolve: async (name, signal, read) => {
        live();
        const catalog = await runtime.catalog(signal, read);
        live();
        if (
          resolvePluginSettingsCatalog(catalog)?.revision !==
            instance.activation.settings!.revision ||
          !settingsActionBindings(document, catalog).some(
            (item) =>
              item.name === child.action &&
              item.revision === child.revision &&
              item.kind === "app",
          )
        )
          throw denied();
        return resolvePluginCatalogTool(catalog, name);
      },
      assertLive: live,
      assertOrigin: (resolved) => {
        if (
          !resolved.appToolsEnabled ||
          !getToolVisibility(resolved.tool._meta).includes("app")
        )
          throw denied();
      },
      validate: (resolved) =>
        pluginToolCallValidation(resolved.tool, body.params.arguments, () =>
          denied(),
        ),
      invoke: (ports, params) =>
        pluginInstances.invoke(
          body.instanceToken,
          actor,
          ports,
          body.operationId,
          params,
          c.req.raw.signal,
          "app",
        ),
    });
  }),
);
routes.post("/app/close", (c) =>
  route(c, async () => {
    const body = childHandle.parse(await c.req.json());
    const bearer = await getConvexBearerForRequest(c);
    const subject = toolApprovalSubjectFromAuthHeader(
      c.req.header("authorization"),
    );
    if (subject === "anonymous") throw denied();
    const actorId = await resolvePluginCleanupActor({
      bearer,
      signal: c.req.raw.signal,
    });
    await pluginInstances.getPersistent(
      body.instanceToken,
      {
        actorId,
        projectId: body.projectId,
        workspaceId: body.pluginWorkspace.workspaceId,
        subject,
      },
      c.req.raw.signal,
    );
    const child = children.get(body.childToken);
    if (child?.parent === body.instanceToken) child.dispose();
    return c.json({ ok: true });
  }),
);
export default routes;
