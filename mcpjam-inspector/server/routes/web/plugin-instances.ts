import { pluginModelAppRoutes } from "./plugin-model-apps.js";
import { preparePluginMessageTurn } from "../../services/plugin-host/message.js";
import {
  pluginMessageIntentSchema,
  pluginMessageParts,
} from "../../../shared/plugin-message.js";

import {
  describePluginFormFiles,
  uploadPluginFormFiles,
} from "../../services/plugin-host/form-files.js";
import {
  pluginFormServiceRequestSchema,
  pluginFormFileUploadRequestSchema,
  PLUGIN_FORM_FILE_MAX_COUNT,
  PLUGIN_FORM_FILE_MAX_BYTES,
} from "../../../shared/plugin-form-services.js";
import {
  openPluginFormAppPreview,
  getPluginFormApp,
} from "../../services/plugin-host/form-app-preview.js";
import { pluginFormPreviewRequestSchema } from "../../../shared/plugin-form-services.js";
import { readPluginFormResourcePreview } from "../../services/plugin-host/form-resource-preview.js";
import {
  PluginFileTargetRefusal,
  pluginFileTargetsWarning,
  refusePluginFileOpen,
} from "../../services/plugin-host/file-targets.js";
import {
  createComputerFileTargetAdapter,
  createProjectComputerConnector,
  resolveComputerFilePath,
  type ComputerFileSystem,
} from "../../services/plugin-host/computer-file-target.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";
import {
  admittedPluginDeepLink,
  admittedPluginNavigationNamespace,
  PluginDeepLinkRefusal,
  readPluginDeepLinkNames,
  resolvePluginDeepLinkTarget,
  selectPluginDeepLinkServer,
} from "../../services/plugin-host/deep-link.js";
import {
  parsePluginDeepLink,
  PluginDeepLinkError,
} from "../../../shared/plugin-deep-link.js";
import settingsRoutes from "./plugin-settings.js";
import { readServerOnboarding } from "../../services/plugin-host/onboarding.js";
import { pluginContextRoutes } from "./plugin-context.js";
import { PluginModelContextError } from "../../../shared/plugin-model-context.js";

import { pluginMentionRoutes } from "./plugin-mentions.js";
import {
  isPluginMentionTool,
  PluginMentionError,
} from "../../../shared/plugin-mentions.js";
import path from "node:path";
import {
  resolveLocalFileTarget,
  resolveLocalFilePath,
} from "../../services/plugin-host/local-file-target.js";
import { stream } from "hono/streaming";
import { streamListedFileUpdates } from "../../services/plugin-host/listed-file-subscription.js";
import {
  pluginFileEntrypointPlan,
  pluginFileNameMatchesExtension,
  parsePluginFileRead,
} from "../../../shared/plugin-file.js";
import { pluginFileEntrypoints } from "../../../shared/plugin-activation.js";
import {
  pluginIconMetadata,
  type PluginIconMetadata,
} from "../../../shared/plugin-icons.js";
import { ownedFileResources } from "../../services/plugin-host/owned-file-resources.js";
import {
  resolveListedFileResource,
  readListedFileBytes,
} from "../../services/plugin-host/listed-file-resource.js";
import { ResourceGrantError } from "../../services/plugin-host/resource-grants.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { getToolVisibility } from "@mcpjam/sdk/widget-runtime";
import { isAbortError } from "../../../shared/abort-errors.js";
import {
  PluginActivationError,
  pluginEntrypointKinds,
  pluginEntrypointPlan,
  pluginEntrypointTitle,
  pluginQuickAction,
} from "../../../shared/plugin-activation.js";
import {
  parsePluginWorkspaceDescriptor,
  PluginWorkspaceRequestError,
} from "../../../shared/plugin-workspace.js";
import {
  admitPluginWorkspace,
  assertPluginWorkspaceRuntime,
  readPluginExecutionContext,
  resolvePluginCleanupActor,
  PluginWorkspaceAdmissionError,
} from "../../services/plugin-host/admission.js";
import { pluginInstances } from "../../services/plugin-host/instances.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";
import {
  pluginActivationFromCatalog,
  resolvePluginActivation,
} from "../../services/plugin-host/activation.js";
import {
  pluginBindingDigest,
  pluginResourceUri,
} from "../../services/plugin-host/bindings.js";
import {
  assertPluginInstanceBindingCurrent,
  assertPluginExtensionEnabled,
  createPluginRequestRuntime,
  PLUGIN_ENTRYPOINT_EXTENSIONS,
  pluginHostExtensions,
  resolvePluginCatalogTool,
} from "../../services/plugin-host/request-runtime.js";
import {
  invokePluginRequest,
  PluginToolCallFailure,
} from "../../services/plugin-host/request-invocation.js";
import { pluginToolCallValidation } from "../../services/plugin-host/tool-call-validation.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { toolApprovalSubjectFromAuthHeader } from "../../utils/tool-approval-token.js";
import { widgetResourceContent } from "../../utils/widget-resource-content.js";
import {
  canSkipListingLookup,
  findListingMetaForUri,
} from "../../utils/ui-resource-meta.js";
import { viewOriginLabelForConfig } from "../../utils/view-origin-label.js";
import { handleRoute } from "./auth.js";
import {
  describePluginError,
  pluginDiagnostic,
  pluginErrorDiagnostic,
  type PluginDiagnostic,
} from "../../../shared/plugin-diagnostics.js";
import {
  timedPluginStep,
  withPluginRequestTimings,
} from "../../services/plugin-host/timing.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { PLUGIN_APP_UI_MAX_BYTES } from "../../../shared/plugin-app-ui-limits.js";

const id = z.string().min(1).max(256);
const scopeSchema = z.strictObject({
  projectId: id,
  pluginWorkspace: z.unknown(),
});
const serverSchema = scopeSchema.extend({ hostId: id, serverId: id });
const openSchema = serverSchema.extend({
  toolName: id,
  threadId: id,
  kind: z.enum(["thread", "global", "quick-action", "file"]).default("thread"),
  resourceUri: z.string().min(1).max(256).optional(),
  requestId: z.string().uuid().optional(),
  deepLink: z.string().max(8192).optional(),
});
const handleSchema = scopeSchema.extend({
  instanceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const approvalSchema = z.strictObject({
  id: z.string().max(4096),
  approved: z.boolean(),
});
const executeSchema = handleSchema.extend({
  approval: approvalSchema.optional(),
  resume: z
    .strictObject({
      continuationId: z.string().min(1).max(256),
      round: z.number().int().positive(),
      responsesBlobId: z.string().min(1).max(512),
    })
    .optional(),
});
const callSchema = executeSchema.extend({
  invocationId: z.string().uuid(),
  params: z.strictObject({
    name: id,
    arguments: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  }),
});
const denied = () => new PluginInvocationError("INSTANCE_DENIED");

async function scope(c: Context, body: z.infer<typeof scopeSchema>) {
  const descriptor = parsePluginWorkspaceDescriptor(body.pluginWorkspace);
  if (!descriptor) throw new PluginWorkspaceRequestError();
  const bearer = await getConvexBearerForRequest(c);
  const subject = toolApprovalSubjectFromAuthHeader(
    c.req.header("authorization"),
  );
  if (subject === "anonymous") throw denied();
  return {
    descriptor,
    bearer,
    identity: {
      projectId: body.projectId,
      workspaceId: descriptor.workspaceId,
      subject,
    },
  };
}
async function admitted(c: Context, body: z.infer<typeof scopeSchema>) {
  const scoped = await scope(c, body);
  const admission = await admitPluginWorkspace({
    ...scoped,
    projectId: body.projectId,
    signal: c.req.raw.signal,
  });
  return {
    ...scoped,
    admission,
    actor: { ...scoped.identity, actorId: admission.actorId },
  };
}
/** Activation routes always report step timings; others only when slow. */
const TIMED_ACTIONS = new Set(["activation/open", "activation/execute"]);
async function route(c: Context, action: () => Promise<Response>) {
  return withPluginRequestTimings(async (timings) => {
    const response = await routeUntimed(c, action);
    try {
      const value = timings.serverTiming();
      response.headers.set("Server-Timing", value);
      const actionName = new URL(c.req.url).pathname.replace(
        /^.*\/plugin-instances\//,
        "",
      );
      const totalMs = Math.round(performance.now() - timings.startedAt);
      if (
        c.var?.requestLogContext &&
        (TIMED_ACTIONS.has(actionName) || totalMs >= 2_000)
      )
        getRequestLogger(c, "routes.web.plugin-instances").event(
          "plugin.instance.request.timing",
          {
            action: actionName.slice(0, 128),
            statusCode: response.status,
            totalMs,
            spans: timings.summary(),
          },
        );
    } catch {
      /* Timing is observational; it never changes the response. */
    }
    return response;
  });
}
/** Every refusal names its code and, when known, a plain-English description. */
const failure = (code: string, extra: Record<string, unknown> = {}) => {
  const description = describePluginError(code);
  return { code, ...(description ? { description } : {}), ...extra };
};
async function routeUntimed(c: Context, action: () => Promise<Response>) {
  try {
    return await action();
  } catch (error) {
    if (isAbortError(error))
      return c.json(failure("PLUGIN_INSTANCE_CANCELLED"), 408);
    if (error instanceof PluginDeepLinkError) {
      return c.json(
        failure("PLUGIN_DEEP_LINK_INVALID", {
          diagnostics: [
            pluginErrorDiagnostic(
              "PLUGIN_DEEP_LINK_INVALID",
              "Deep link refused: not a valid plugin link",
            ),
          ],
        }),
        400,
      );
    }
    if (error instanceof PluginDeepLinkRefusal) {
      const candidates = error.candidates.slice(0, 16);
      return c.json(
        failure(error.code, {
          ...(candidates.length ? { candidates } : {}),
          diagnostics: [
            pluginErrorDiagnostic(
              error.code,
              `Deep link refused: ${error.code
                .replace("PLUGIN_DEEP_LINK_", "")
                .toLowerCase()
                .replaceAll("_", " ")}`,
              candidates.length ? { candidates } : undefined,
            ),
          ],
        }),
        error.code === "PLUGIN_DEEP_LINK_AMBIGUOUS" ? 409 : 400,
      );
    }
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      error instanceof PluginWorkspaceRequestError ||
      error instanceof PluginActivationError ||
      error instanceof PluginMentionError ||
      error instanceof PluginModelContextError
    )
      return c.json(failure("INVALID_PLUGIN_INSTANCE_REQUEST"), 400);
    if (error instanceof PluginWorkspaceAdmissionError)
      return c.json(failure(error.code), error.status);
    if (error instanceof ResourceGrantError)
      return c.json(failure(error.code), 403);
    if (error instanceof PluginFileTargetRefusal)
      return c.json(
        failure(error.code, { diagnostics: error.diagnostics }),
        error.status,
      );
    // A refusal can carry entries for the client's Logs panel.
    const logged =
      error instanceof PluginInvocationError && error.diagnostics?.length
        ? { diagnostics: error.diagnostics }
        : {};
    if (error instanceof PluginToolCallFailure)
      return c.json(
        failure(error.code, {
          outcomeUnknown: false,
          ...(error.serverMessage ? { message: error.serverMessage } : {}),
          ...(error.serverCode !== undefined
            ? { serverCode: error.serverCode }
            : {}),
          ...logged,
        }),
        502,
      );
    if (error instanceof PluginInvocationError)
      return c.json(
        failure(error.code, { outcomeUnknown: error.outcomeUnknown, ...logged }),
        error.outcomeUnknown ? 409 : 403,
      );
    return handleRoute(c, async () => {
      throw error;
    });
  }
}
const instances = new Hono();
instances.use("*", bodyLimit({ maxSize: 512 * 1024 }));
instances.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

instances.route(
  "/model",
  pluginModelAppRoutes({
    route,
    admitted,
    cleanup: async (c, body) => {
      const scoped = await scope(c, body);
      const actorId = await resolvePluginCleanupActor({
        bearer: scoped.bearer,
        signal: c.req.raw.signal,
      });
      return { ...scoped.identity, actorId };
    },
  }),
);
instances.route("/settings", settingsRoutes);
instances.post("/message/prepare", (c) =>
  route(c, async () => {
    const body = serverSchema
      .extend({ intent: pluginMessageIntentSchema })
      .parse(await c.req.json());
    const { admission, bearer } = await admitted(c, body);
    const preparationToken = await preparePluginMessageTurn({
      c,
      admission,
      bearer,
      intent: body.intent,
      hostId: body.hostId,
      serverIds: [body.serverId],
      threadId: body.intent.sourceThreadId,
      messages: [
        {
          id: body.intent.operationId,
          role: "user",
          parts: pluginMessageParts(body.intent.params),
        },
      ],
      prepareOnly: true,
    });
    return c.json({ preparationToken });
  }),
);

/** A saved server is sufficient. This reads declarations and never opens or executes. */
instances.route("/context", pluginContextRoutes({ route, admitted }));
instances.route(
  "/mentions",
  pluginMentionRoutes({
    route,
    admitted,
    cleanup: async (c, body) => {
      const scoped = await scope(c, body);
      const actorId = await resolvePluginCleanupActor({
        bearer: scoped.bearer,
        signal: c.req.raw.signal,
      });
      return { ...scoped.identity, actorId };
    },
  }),
);

/** Icons for discovery: each entrypoint tool's `icons`, plus the server icon
 * (initialize `serverInfo.icons`, or `server/discover`'s serverInfo on
 * 2026-07-28), so the client resolves tool → server → generic. Bounded per
 * tool and per response; data: images past the byte budget are dropped. */
const DISCOVERY_ICONS_PER_TOOL = 4;
const DISCOVERY_ICON_BYTES = 512 * 1024;
function discoveryIcons(serverInfoIcons: unknown) {
  let budget = DISCOVERY_ICON_BYTES;
  const take = (icons: PluginIconMetadata["toolIcons"]) =>
    icons.slice(0, DISCOVERY_ICONS_PER_TOOL).filter((icon) => {
      const size = icon.src.length;
      if (size > budget) return false;
      budget -= size;
      return true;
    });
  const serverIcons = take(pluginIconMetadata([], serverInfoIcons).serverIcons);
  return {
    serverIcons,
    toolIcons: (icons: unknown) =>
      take(pluginIconMetadata(icons, []).toolIcons),
  };
}

instances.post("/discover", (c) =>
  route(c, async () => {
    const body = serverSchema.parse(await c.req.json());
    const { admission, bearer } = await admitted(c, body);
    const runtime = createPluginRequestRuntime(c, admission, bearer, body);
    try {
      const catalog = await runtime.catalog(c.req.raw.signal);
      const icons = discoveryIcons(
        catalog.manager?.getInitializationInfo?.(body.serverId)?.serverVersion
          ?.icons,
      );
      // Launchers exist only for extensions this client has turned on.
      const allowed = (kind: keyof typeof PLUGIN_ENTRYPOINT_EXTENSIONS) =>
        catalog.extensions?.capabilities[PLUGIN_ENTRYPOINT_EXTENSIONS[kind]] !==
        false;
      const entries = catalog.tools.flatMap((tool) => {
        const kinds = pluginEntrypointKinds(tool).filter(
          (kind) => (kind === "thread" || kind === "global") && allowed(kind),
        );
        if (!kinds.length) return [];
        try {
          pluginResourceUri(tool._meta);
        } catch {
          return [];
        }
        const action = pluginQuickAction(tool);
        const toolIcons = icons.toolIcons(
          (tool as { icons?: unknown }).icons,
        );
        return [
          ...kinds.map((kind) => ({
            toolName: tool.name,
            title: pluginEntrypointTitle(tool),
            kind,
            ...(toolIcons.length ? { toolIcons } : {}),
          })),
          ...(action && allowed("quick-action")
            ? [
                {
                  toolName: tool.name,
                  title: action.title,
                  kind: "quick-action" as const,
                  ...(toolIcons.length ? { toolIcons } : {}),
                },
              ]
            : []),
        ];
      });
      // Whether this server offers @ mention search, so the composer need
      // not probe every server for a mention tool.
      const mentionTools =
        catalog.extensions?.capabilities.mentions === false
          ? []
          : catalog.tools.filter(isPluginMentionTool);
      // The installed plugin that owns this server, so the client can show
      // that plugin's manifest icons (its project plugin list carries them).
      // Display only: never authority.
      const pluginId =
        catalog.serverIdentity?.kind === "plugin"
          ? catalog.serverIdentity.pluginId
          : undefined;
      return c.json({
        entries,
        ...(icons.serverIcons.length ? { serverIcons: icons.serverIcons } : {}),
        ...(pluginId ? { pluginId } : {}),
        mentions:
          mentionTools.length === 1
            ? {
                available: true,
                toolName: mentionTools[0].name,
                title: mentionTools[0].title ?? mentionTools[0].name,
              }
            : { available: false },
      });
    } finally {
      await runtime.release();
    }
  }),
);

instances.post("/onboarding", (c) =>
  route(c, async () => {
    const body = serverSchema
      .extend({ content: z.boolean() })
      .parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    const result = await readServerOnboarding({
      ...body,
      actorId: actor.actorId,
      bearer,
      signal: c.req.raw.signal,
    });
    await admission.revalidate({ signal: c.req.raw.signal });
    return c.json(result);
  }),
);

instances.post("/files/discover", (c) =>
  route(c, async () => {
    const body = serverSchema
      .extend({ resourceUri: z.string().min(1).max(256) })
      .parse(await c.req.json());
    const { admission, bearer } = await admitted(c, body);
    const runtime = createPluginRequestRuntime(c, admission, bearer, body);
    try {
      const current = await runtime.catalog(c.req.raw.signal);
      if (current.extensions)
        assertPluginExtensionEnabled(current.extensions, "fileViewers");
      const file = await resolveListedFileResource(
        current.manager,
        body.serverId,
        body.resourceUri,
        c.req.raw.signal,
      );
      const localTarget = resolveLocalFileTarget(
        current.localFileTargetContract,
        body.serverId,
        file.uri,
      );
      const name = localTarget
        ? path.basename(localTarget.relativePath)
        : file.name;
      const icons = discoveryIcons(
        current.manager?.getInitializationInfo?.(body.serverId)?.serverVersion
          ?.icons,
      );
      const entries = pluginFileEntrypoints(current.tools)
        .filter((entry) =>
          entry.extensions.some((extension) =>
            pluginFileNameMatchesExtension(name, extension),
          ),
        )
        .map((entry) => {
          const toolIcons = icons.toolIcons(
            (
              current.tools.find((tool) => tool.name === entry.toolName) as
                | { icons?: unknown }
                | undefined
            )?.icons,
          );
          return toolIcons.length ? { ...entry, toolIcons } : entry;
        });
      await admission.revalidate({ signal: c.req.raw.signal });
      // A declared file target that can't be used: the file still opens
      // read-only through the server; say why saving is off.
      const fileWarnings =
        localTarget || !current.fileTargets
          ? []
          : pluginFileTargetsWarning(current.fileTargets, body.serverId);
      return c.json({
        entries,
        file: { uri: file.uri, name },
        ...(icons.serverIcons.length ? { serverIcons: icons.serverIcons } : {}),
        ...(fileWarnings.length ? { diagnostics: fileWarnings } : {}),
      });
    } finally {
      await runtime.release();
    }
  }),
);
const fileRequestSchema = handleSchema.extend({ params: z.unknown() });
/** Connectors for the project's Computer (hosted file targets). Replaced in tests. */
export const pluginComputerFiles = {
  connector: (serverId: string) => createProjectComputerConnector(serverId),
};
/** One Computer connection per request, made only when a file op needs it. */
function computerPort(
  bearer: string,
  projectId: string,
  serverId: string,
  executionScope: () => ExecutionScope | undefined,
) {
  let pending: Promise<ComputerFileSystem> | undefined;
  return (signal: AbortSignal) =>
    (pending ??= pluginComputerFiles
      .connector(serverId)({
        bearer,
        projectId,
        executionScope: executionScope(),
        signal,
      })
      .catch((error: unknown) => {
        pending = undefined;
        throw error;
      }));
}
async function fileAccess(
  c: Context,
  body: z.infer<typeof fileRequestSchema>,
  /** This request's own admission, when the caller already has it. */
  context?: Pick<Awaited<ReturnType<typeof admitted>>, "admission" | "bearer" | "actor">,
) {
  const { admission, bearer, actor } = context ?? (await admitted(c, body));
  const instance = await pluginInstances.getPersistent(
    body.instanceToken,
    actor,
    c.req.raw.signal,
  );
  const file = instance.activation.file;
  if (!file) throw denied();
  const runtime = createPluginRequestRuntime(
    c,
    admission,
    bearer,
    { hostId: instance.hostId, serverId: instance.owner.serverId },
    instance,
  );
  let current: Awaited<ReturnType<typeof runtime.resolve>>;
  const authorize = async (signal: AbortSignal) => {
    pluginInstances.get(body.instanceToken, actor);
    current = await runtime.resolve(instance.activation.toolName, signal);
    if (current.revision !== instance.activation.revision) throw denied();
    if (current.extensions)
      assertPluginExtensionEnabled(current.extensions, "fileResources");
    const listed = await resolveListedFileResource(
      current.manager,
      instance.owner.serverId,
      file.uri,
      signal,
    );
    if (
      listed.name !== (file.sourceName ?? file.name) ||
      pluginBindingDigest(
        resolveLocalFileTarget(
          current.localFileTargetContract,
          instance.owner.serverId,
          file.uri,
        ) ?? null,
      ) !== pluginBindingDigest(file.localTarget ?? null)
    )
      throw denied();
    await admission.revalidate({ signal });
  };

  const lifetime = pluginInstances.signal(body.instanceToken, actor);
  let session: ReturnType<typeof ownedFileResources.get>;
  try {
    session = ownedFileResources.get(instance, lifetime);
  } catch (error) {
    await runtime.release();
    throw error;
  }
  return {
    runtime,
    lifetime,
    instance,
    file,
    session,
    authorize,
    current: () => current,
    run: <T>(effect: () => Promise<T>) =>
      ownedFileResources.run(
        instance,
        {
          authorize,
          read: async (uri, signal) =>
            readListedFileBytes(
              await current.manager.readResource(
                instance.owner.serverId,
                { uri },
                { signal },
              ),
              uri,
            ),
          computer: computerPort(
            bearer,
            admission.projectId,
            instance.owner.serverId,
            () => current?.executionScope,
          ),
        },
        effect,
      ),
  };
}
instances.post("/files/read", (c) =>
  route(c, async () => {
    const body = fileRequestSchema.parse(await c.req.json());
    const access = await fileAccess(c, body);
    try {
      const params = parsePluginFileRead(body.params);
      let result: Awaited<ReturnType<typeof access.session.read>>;
      try {
        result = await access.run(() =>
          access.session.read(body.params, c.req.raw.signal),
        );
      } catch (error) {
        if (
          error instanceof ResourceGrantError &&
          error.code === "RESOURCE_NOT_TEXT"
        )
          return c.json(
            failure(error.code, {
              diagnostics: [
                pluginErrorDiagnostic(
                  error.code,
                  `File read failed: ${access.file.name} isn't text`,
                  { file: access.file.name, representation: "text" },
                ),
              ],
            }),
            403,
          );
        throw error;
      }
      // Each read is logged with the representation returned, and the App is
      // warned when it left the choice to the host.
      const requested = params.representation;
      const returned = result.contents.some((item) => "blob" in item)
        ? "blob"
        : "text";
      const diagnostics = [
        pluginDiagnostic(
          "info",
          "PLUGIN_FILE_READ",
          `File read: ${access.file.name} returned ${returned}`,
          requested
            ? `The App asked for ${requested} and received ${returned}.`
            : `The App didn't request a representation, so the host returned ${returned} (text when the bytes are valid UTF-8, otherwise base64 blob).`,
          {
            file: access.file.name,
            returned,
            ...(requested ? { requested } : {}),
          },
        ),
        ...(requested
          ? []
          : [
              pluginDiagnostic(
                "warning",
                "PLUGIN_FILE_READ_REPRESENTATION_UNSPECIFIED",
                `File read: ${access.file.name} has no representation`,
                'Set _meta["openai/resource"].representation to "text" or "blob" on resources/read. Without it, the same viewer can get text for one file and blob for another, and other clients may choose differently.',
                { file: access.file.name },
              ),
            ]),
      ].map((diagnostic) => ({
        ...diagnostic,
        serverId: access.instance.owner.serverId,
      }));
      return c.json({ ...result, diagnostics });
    } finally {
      await access.runtime.release();
    }
  }),
);
instances.post("/files/open", (c) =>
  route(c, async () => {
    const body = handleSchema
      .extend({ path: z.string().min(1).max(4096) })
      .parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    const instance = await pluginInstances.getPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
    );
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: instance.hostId, serverId: instance.owner.serverId },
      instance,
    );
    try {
      const current = await runtime.catalog(c.req.raw.signal);
      if (current.extensions) {
        assertPluginExtensionEnabled(current.extensions, "localFiles");
        assertPluginExtensionEnabled(current.extensions, "fileViewers");
      }
      const fileIdentity = {
        actorId: actor.actorId,
        projectId: actor.projectId,
        serverId: instance.owner.serverId,
      };
      // Say what's missing (an allowed folder, a listed file) instead of a
      // bare denial, and log it.
      if (!current.localFileTargetContract)
        refusePluginFileOpen(
          current.fileTargets ?? { placement: "local" },
          fileIdentity,
        );
      const onComputer = current.fileTargets?.placement === "computer";
      const target = (onComputer ? resolveComputerFilePath : resolveLocalFilePath)(
        current.localFileTargetContract,
        instance.owner.serverId,
        body.path,
      );
      if (!target)
        refusePluginFileOpen(
          { placement: onComputer ? "computer" : "local" },
          fileIdentity,
        );
      // On the Computer, the path is resolved on the VM itself.
      if (onComputer)
        await createComputerFileTargetAdapter(
          target!,
          computerPort(
            bearer,
            admission.projectId,
            instance.owner.serverId,
            () => current.executionScope,
          ),
        ).check(c.req.raw.signal);
      const file = await resolveListedFileResource(
        current.manager,
        instance.owner.serverId,
        target.uri,
        c.req.raw.signal,
      );
      const icons = discoveryIcons(
        current.manager?.getInitializationInfo?.(instance.owner.serverId)
          ?.serverVersion?.icons,
      );
      const entries = pluginFileEntrypoints(current.tools)
        .filter((entry) =>
          entry.extensions.some((extension) =>
            pluginFileNameMatchesExtension(
              path.basename(target.relativePath),
              extension,
            ),
          ),
        )
        .map((entry) => {
          const toolIcons = icons.toolIcons(
            (
              current.tools.find((tool) => tool.name === entry.toolName) as
                | { icons?: unknown }
                | undefined
            )?.icons,
          );
          return toolIcons.length ? { ...entry, toolIcons } : entry;
        });
      await admission.revalidate({ signal: c.req.raw.signal });
      return c.json({
        file,
        entries,
        ...(icons.serverIcons.length ? { serverIcons: icons.serverIcons } : {}),
      });
    } finally {
      await runtime.release();
    }
  }),
);
instances.post("/files/write", (c) =>
  route(c, async () => {
    const body = fileRequestSchema
      .extend({ operationId: z.string().uuid() })
      .parse(await c.req.json());
    const access = await fileAccess(c, body);
    try {
      if (!access.file.localTarget)
        throw new PluginFileTargetRefusal(
          "PLUGIN_FILE_READ_ONLY",
          access.instance.owner.serverId,
          `Couldn't save ${access.file.name}: the file is read-only`,
          { file: access.file.name },
        );
      try {
        return c.json(
          await access.run(() =>
            access.session.write(
              body.operationId,
              body.params,
              c.req.raw.signal,
            ),
          ),
        );
      } catch (error) {
        // A refused save says why, here and in the Logs panel. The viewer
        // keeps its unsaved state; nothing is dropped.
        if (
          error instanceof ResourceGrantError &&
          error.code !== "RESOURCE_OUTCOME_UNKNOWN"
        )
          return c.json(
            failure(error.code, {
              diagnostics: [
                {
                  ...pluginErrorDiagnostic(
                    error.code,
                    `Save refused: ${access.file.name}`,
                    { file: access.file.name },
                  ),
                  level: "warning" as const,
                  serverId: access.instance.owner.serverId,
                },
              ],
            }),
            403,
          );
        throw error;
      }
    } finally {
      await access.runtime.release();
    }
  }),
);
instances.post("/files/subscribe", (c) =>
  route(c, async () => {
    const body = fileRequestSchema.parse(await c.req.json());
    const access = await fileAccess(c, body);
    try {
      const params = parsePluginFileRead(body.params);
      if (params.uri !== access.session.input.file.resourceUri) throw denied();
      await access.run(() => access.session.toolMetadata());
      if (
        !access.file.localTarget &&
        !access
          .current()
          .manager.getServerCapabilities(access.instance.owner.serverId)
          ?.resources?.subscribe
      )
        throw denied();
    } catch (error) {
      await access.runtime.release();
      throw error;
    }
    c.header("Content-Type", "application/x-ndjson");
    c.header("Cache-Control", "no-store");
    return stream(c, async (output) => {
      const abort = new AbortController();
      output.onAbort(() => abort.abort());
      const signal = AbortSignal.any([
        abort.signal,
        access.lifetime,
        c.req.raw.signal,
        AbortSignal.timeout(60_000),
      ]);
      try {
        if (access.file.localTarget) {
          await access.run(async () => {
            await access.session.subscribe(
              body.params,
              (uri) => {
                void output
                  .write(JSON.stringify({ uri }) + "\n")
                  .catch(() => abort.abort());
              },
              signal,
            );
            await output.write(JSON.stringify({ ready: true }) + "\n");
            if (!signal.aborted)
              await new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              );
            await access.session.unsubscribe(body.params);
          });
          return;
        }
        await access.run(() =>
          streamListedFileUpdates({
            manager: access.current().manager,
            serverId: access.instance.owner.serverId,
            sourceUri: access.file.uri,
            publicUri: access.session.input.file.resourceUri,
            signal,
            authorize: async () => {
              signal.throwIfAborted();
              await access.session.toolMetadata();
              signal.throwIfAborted();
            },
            ready: async () => {
              await output.write(JSON.stringify({ ready: true }) + "\n");
            },
            emit: async (uri) => {
              await output.write(JSON.stringify({ uri }) + "\n");
            },
          }),
        );
      } finally {
        await access.runtime.release();
      }
    });
  }),
);

/** Metadata the App sees for the tools it may call: every catalog page, only
 * tools visible to Apps, bounded in count and bytes. */
export const PLUGIN_APP_TOOLS_METADATA_BYTES = 256 * 1024;
export const PLUGIN_APP_TOOLS_METADATA_COUNT = 512;
export function pluginAppToolsMetadata(
  tools: readonly { name: string; _meta?: Record<string, unknown> }[],
) {
  const value: Record<string, Record<string, unknown>> = Object.create(null);
  let bytes = 2;
  let count = 0;
  let omitted = 0;
  for (const tool of tools) {
    if (!getToolVisibility(tool._meta).includes("app")) continue;
    const meta = tool._meta ?? {};
    const size =
      Buffer.byteLength(JSON.stringify(tool.name)) +
      Buffer.byteLength(JSON.stringify(meta) ?? "{}") +
      2;
    if (
      count >= PLUGIN_APP_TOOLS_METADATA_COUNT ||
      bytes + size > PLUGIN_APP_TOOLS_METADATA_BYTES
    ) {
      omitted++;
      continue;
    }
    value[tool.name] = meta;
    bytes += size;
    count++;
  }
  return {
    value,
    diagnostics: omitted
      ? [
          pluginDiagnostic(
            "warning",
            "PLUGIN_APP_TOOLS_METADATA_TRUNCATED",
            `App tool metadata truncated (${omitted} tool(s) omitted)`,
            `The App receives metadata for at most ${PLUGIN_APP_TOOLS_METADATA_COUNT} App-visible tools and ${PLUGIN_APP_TOOLS_METADATA_BYTES / 1024} KB. ${omitted} App-visible tool(s) were left out; the App can still call them.`,
            { omitted },
          ),
        ]
      : [],
  };
}

instances.post("/activation/open", (c) =>
  route(c, async () => {
    const body = openSchema.parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    const runtime = createPluginRequestRuntime(c, admission, bearer, body);
    try {
      const selector =
        body.kind === "quick-action" || body.kind === "file"
          ? {
              kind: body.kind,
              requestId: z.string().uuid().parse(body.requestId),
            }
          : body.kind === "global"
            ? { kind: "global" as const }
            : { kind: "thread" as const, threadId: body.threadId };
      // One freshly admitted, complete catalog serves the activation plan, the
      // UI resource declaration and the App's tool metadata. Its connection
      // reads admission before and after the listing; one more batched read
      // after the durable write below closes the request.
      const catalog = await runtime.catalog(c.req.raw.signal);
      if (catalog.extensions) {
        assertPluginExtensionEnabled(
          catalog.extensions,
          PLUGIN_ENTRYPOINT_EXTENSIONS[body.kind],
        );
        if (body.deepLink !== undefined)
          assertPluginExtensionEnabled(catalog.extensions, "deepLinks");
      }
      const activation =
        selector.kind === "quick-action"
          ? pluginActivationFromCatalog(catalog, body.toolName, selector)
          : undefined;
      const current =
        activation?.resource ??
        resolvePluginCatalogTool(catalog, body.toolName);
      // A link may name the plugin by installation ID, manifest name or
      // published ID; read the names only when the link needs them.
      const linkNames =
        body.deepLink !== undefined &&
        current.serverIdentity.kind === "plugin" &&
        parsePluginDeepLink(body.deepLink).pluginId !==
          current.serverIdentity.pluginId
          ? (
              await readPluginDeepLinkNames({
                bearer,
                projectId: body.projectId,
                signal: c.req.raw.signal,
              })
            ).get(current.serverIdentity.pluginId)
          : undefined;
      const validateLink = (resolved: typeof current) =>
        admittedPluginDeepLink(body.deepLink, {
          serverIdentity: resolved.serverIdentity,
          runtime: resolved.runtime,
          toolName: body.toolName,
          kind: body.kind,
          names: linkNames,
        });
      validateLink(current);
      const listedFile =
        body.kind === "file"
          ? await resolveListedFileResource(
              current.manager,
              body.serverId,
              z.string().min(1).parse(body.resourceUri),
              c.req.raw.signal,
            )
          : undefined;
      const localTarget = listedFile
        ? resolveLocalFileTarget(
            current.localFileTargetContract,
            body.serverId,
            listedFile.uri,
          )
        : undefined;
      const file = listedFile
        ? {
            ...listedFile,
            kind: "saved-resource" as const,
            version: 1 as const,
            sourceName: listedFile.name,
            name: localTarget
              ? path.basename(localTarget.relativePath)
              : listedFile.name,
            ...(localTarget ? { localTarget } : {}),
          }
        : undefined;
      const previewInput = file
        ? { file: { name: file.name, resourceUri: "host-resource://pending" } }
        : {};
      if (file) pluginFileEntrypointPlan(current.tool, previewInput);
      else if (!activation) pluginEntrypointPlan(current.tool, selector);
      if (!activation)
        pluginToolCallValidation(
          current.tool,
          previewInput,
          () => new PluginInvocationError("ACTIVATION_SCHEMA_INVALID"),
        );
      const uri = pluginResourceUri(current.tool._meta);
      const resource = await timedPluginStep("resources-read", () =>
        current.manager.readResource(
          body.serverId,
          { uri },
          { signal: c.req.raw.signal },
        ),
      );
      const content = resource.contents.find((item) => item.uri === uri);
      const listingMeta = canSkipListingLookup(content?._meta)
        ? undefined
        : await timedPluginStep("resources-list", () =>
            findListingMetaForUri(current.manager, body.serverId, uri),
          );
      const widgetContent = widgetResourceContent(content, listingMeta);
      if (
        !widgetContent.mimeTypeValid ||
        Buffer.byteLength(widgetContent.html) > PLUGIN_APP_UI_MAX_BYTES
      )
        throw new PluginInvocationError("INSTANCE_UI_UNAVAILABLE");
      const opened = await pluginInstances.openActivationPersistent(
        actor,
        {
          runtime: current.runtime,
          contextEnabled: current.contextEnabled,
          messageEnabled: current.messageEnabled,
          hostId: body.hostId,
          hostRevision: current.hostRevision,
          serverId: body.serverId,
          bindingId: current.bindingId,
          serverIdentity: current.serverIdentity,
          resourceUri: uri,
          activation: {
            selector,
            toolName: activation?.plan.params.name ?? current.tool.name,
            revision: activation?.revision ?? current.revision,
            ...(activation
              ? {
                  sourceToolName: body.toolName,
                  arguments: activation.plan.params.arguments,
                  presentation: activation.presentation,
                }
              : {}),
            ...(file ? { file } : {}),
          },
        },
        c.req.raw.signal,
      );
      const toolsMetadata = pluginAppToolsMetadata(catalog.tools);
      // Final fence: ONE batched read proves the actor is still admitted and
      // the host and saved server identity are unchanged after the write.
      await runtime.verifyCurrent(c.req.raw.signal);
      c.req.raw.signal.throwIfAborted();
      const link = validateLink(current);
      const navigationNamespace =
        current.extensions?.capabilities.deepLinks === false
          ? undefined
          : admittedPluginNavigationNamespace(
              current.serverIdentity,
              current.runtime,
              body.kind,
            );
      return c.json({
        ...(link ? { deepLink: { url: link.url } } : {}),
        ...(navigationNamespace
          ? {
              deepLinkNamespace: navigationNamespace,
            }
          : {}),
        contextEnabled: opened.instance.contextEnabled === true,
        messageEnabled: opened.instance.messageEnabled === true,
        ...(opened.instance.contextEnabled
          ? {
              contextSnapshot: pluginInstances.contextSnapshot(
                opened.token,
                actor,
              ),
            }
          : {}),

        instanceToken: opened.token,
        instanceId: opened.instance.owner.instanceId,
        generation: opened.instance.owner.generation,
        operationId: opened.instance.activation.operationId,
        // The lease: the client renews before it and never reuses the handle
        // after it.
        ...(opened.expiresAt ? { expiresAt: opened.expiresAt } : {}),
        resourceUri: uri,
        toolTitle: activation
          ? pluginQuickAction(activation.source.tool)?.title
          : pluginEntrypointTitle(current.tool),
        presentation: activation?.presentation ?? "app",
        localFilesAvailable: !!current.localFileTargetContract,
        ...(file
          ? {
              fileCapabilities: {
                write: !!file.localTarget,
                // Computer files can't be watched through the sandbox API.
                subscribe: file.localTarget
                  ? current.fileTargets?.placement !== "computer"
                  : catalog.serverCapabilities?.resources?.subscribe === true,
              },
              file: ownedFileResources.get(
                opened.instance,
                pluginInstances.signal(opened.token, actor),
                { opened: true },
              ).input.file,
            }
          : {}),
        toolMetadata: current.tool._meta,
        appToolsEnabled: current.appToolsEnabled,
        toolsMetadata: toolsMetadata.value,
        ...(toolsMetadata.diagnostics.length || (file && !file.localTarget)
          ? {
              diagnostics: [
                ...toolsMetadata.diagnostics.map((diagnostic) => ({
                  ...diagnostic,
                  serverId: body.serverId,
                })),
                ...(file && !file.localTarget && current.fileTargets
                  ? pluginFileTargetsWarning(current.fileTargets, body.serverId)
                  : []),
              ],
            }
          : {}),
        widgetContent: {
          ...widgetContent,
          permissive: false,
          injectedOpenAiCompat: false,
          viewOriginLabel: viewOriginLabelForConfig(
            current.manager.getServerConfig(body.serverId),
          ),
        },
      });
    } finally {
      await runtime.release();
    }
  }),
);

async function invoke(
  c: Context,
  body: z.infer<typeof executeSchema> | z.infer<typeof callSchema>,
  origin: "entrypoint" | "app" | "quick-action",
) {
  const { admission, bearer, actor } = await admitted(c, body);
  // The instance's durable control, read once for this phase: the fence's
  // first read (the route's first resolution, below) stands on it for its
  // control leg and adds only the admission and host read.
  const { instance, fence } = await pluginInstances.readFenced(
    body.instanceToken,
    actor,
    c.req.raw.signal,
  );
  if (
    origin === "entrypoint" &&
    instance.activation.selector.kind === "quick-action"
  )
    origin = "quick-action";
  const params =
    "params" in body
      ? body.params
      : {
          name: instance.activation.toolName,
          arguments: instance.activation.file
            ? ownedFileResources.get(
                instance,
                pluginInstances.signal(body.instanceToken, actor),
              ).input
            : (instance.activation.arguments ?? {}),
        };
  const invocationId =
    "invocationId" in body
      ? body.invocationId
      : instance.activation.operationId;
  const runtime = createPluginRequestRuntime(
    c,
    admission,
    bearer,
    { hostId: instance.hostId, serverId: instance.owner.serverId },
    instance,
  );
  const resolveActivation: typeof runtime.resolve =
    origin === "quick-action"
      ? async (name, signal, read) => {
          const resolved = await resolvePluginActivation(
            runtime,
            instance.activation.sourceToolName!,
            instance.activation.selector,
            signal,
            read,
          );
          if (
            resolved.plan.params.name !== name ||
            resolved.resourceUri !== instance.resourceUri ||
            resolved.presentation !== instance.activation.presentation ||
            pluginBindingDigest(resolved.plan.params.arguments) !==
              pluginBindingDigest(params.arguments)
          )
            throw denied();
          return resolved;
        }
      : runtime.resolve;
  // The first resolution makes the instance's fenced read (durable control
  // beside admission), so the invoker's first authorization can reuse it.
  // Await the complete dispatch/delivery before releasing its request-owned manager.
  return await invokePluginRequest(c, {
    actor,
    owner: instance.owner,
    admission,
    runtime,
    resolve: resolveActivation,
    origin,
    invocationId,
    params,
    approval: body.approval,
    resume: body.resume,
    firstRead: fence.read,
    assertLive: () => {
      pluginInstances.get(body.instanceToken, actor);
    },
    assertOrigin: (resolved) => {
      if (origin === "app") {
        if (
          !resolved.appToolsEnabled ||
          !getToolVisibility(resolved.tool._meta).includes("app")
        )
          throw denied();
      } else if (origin === "quick-action") {
        if (
          resolved.revision !== instance.activation.revision ||
          params.name !== instance.activation.toolName
        )
          throw denied();
      } else {
        if (
          resolved.revision !== instance.activation.revision ||
          params.name !== instance.activation.toolName ||
          pluginResourceUri(resolved.tool._meta) !== instance.resourceUri
        )
          throw denied();
        if (instance.activation.file)
          pluginFileEntrypointPlan(resolved.tool, params.arguments);
        else pluginEntrypointPlan(resolved.tool, instance.activation.selector);
      }
    },
    validate: ({ tool }) =>
      pluginToolCallValidation(
        tool,
        params.arguments ?? {},
        (kind) =>
          new PluginInvocationError(
            `INSTANCE_TOOL_${kind.toUpperCase()}_INVALID`,
          ),
      ),
    ...(instance.activation.file?.localTarget
      ? {
          hostMetadata: async (
            next: { _meta?: Record<string, unknown> },
            signal: AbortSignal,
          ) => {
            const file = instance.activation.file!;
            let scope: ExecutionScope | undefined;
            const session = ownedFileResources.get(
              instance,
              pluginInstances.signal(body.instanceToken, actor),
            );
            return ownedFileResources.run(
              instance,
              {
                authorize: async (active) => {
                  pluginInstances.get(body.instanceToken, actor);
                  const current = await runtime.resolve(
                    instance.activation.toolName,
                    active,
                  );
                  scope = current.executionScope;
                  if (
                    current.revision !== instance.activation.revision ||
                    pluginBindingDigest(
                      resolveLocalFileTarget(
                        current.localFileTargetContract,
                        instance.owner.serverId,
                        file.uri,
                      ) ?? null,
                    ) !== pluginBindingDigest(file.localTarget ?? null)
                  )
                    throw denied();
                  await ownedFileResources
                    .targetAdapter(instance, file.localTarget!)
                    .read(file.uri, active);
                  await admission.revalidate({ signal: active });
                  signal.throwIfAborted();
                },
                read: async () => {
                  throw denied();
                },
                computer: computerPort(
                  bearer,
                  admission.projectId,
                  instance.owner.serverId,
                  () => scope,
                ),
              },
              () => session.toolMetadata(next._meta),
            );
          },
        }
      : {}),
    invoke: (ports, next) =>
      pluginInstances.invoke(
        body.instanceToken,
        actor,
        ports,
        invocationId,
        next,
        AbortSignal.any([
          c.req.raw.signal,
          pluginInstances.signal(body.instanceToken, actor),
        ]),
        origin,
        fence,
      ),
  });
}
instances.post("/activation/execute", (c) =>
  route(c, async () =>
    invoke(c, executeSchema.parse(await c.req.json()), "entrypoint"),
  ),
);
instances.post("/call", (c) =>
  route(c, async () => invoke(c, callSchema.parse(await c.req.json()), "app")),
);
/** Resolve a plugin link clicked or pasted in chat to the installed plugin
 * (or plain server) it names, among this chat's servers. The client then
 * opens that server's global App with the same link through
 * /activation/open, which admits it again. */
instances.post("/deep-link/resolve", (c) =>
  route(c, async () => {
    const body = scopeSchema
      .extend({
        hostId: id,
        serverIds: z.array(id).min(1).max(64),
        url: z.string().min(1).max(8192),
      })
      .parse(await c.req.json());
    parsePluginDeepLink(body.url);
    const { admission, bearer } = await admitted(c, body);
    const signal = c.req.raw.signal;
    const context = await timedPluginStep("backend-admission-read", () =>
      readPluginExecutionContext({
        projectId: body.projectId,
        expectedActorId: admission.actorId,
        bearer,
        serverIds: body.serverIds,
        hostId: body.hostId,
        signal,
      }),
    );
    const config = context.hostConfig;
    if (!config) throw denied();
    assertPluginWorkspaceRuntime({
      harness: config.harness,
      hostPolicy: { hostStyle: config.hostStyle },
    });
    assertPluginExtensionEnabled(pluginHostExtensions(config), "deepLinks");
    const identities = [...new Set(body.serverIds)].map((serverId) => ({
      serverId,
      serverName: context.serverNamesById[serverId],
      serverIdentity: context.serverBindings.get(serverId)!,
    }));
    const names = identities.some(
      ({ serverIdentity }) => serverIdentity.kind === "plugin",
    )
      ? await readPluginDeepLinkNames({
          bearer,
          projectId: body.projectId,
          signal,
        })
      : new Map();
    const { link, servers } = resolvePluginDeepLinkTarget(body.url, {
      runtime: config.harness === "codex" ? "codex" : "chatgpt",
      candidates: identities.map((candidate) => ({
        ...candidate,
        ...(candidate.serverIdentity.kind === "plugin" &&
        names.has(candidate.serverIdentity.pluginId)
          ? { names: names.get(candidate.serverIdentity.pluginId) }
          : {}),
      })),
    });
    let target = servers[0];
    if (servers.length > 1) {
      // Several servers of one plugin: exactly one may declare the global App.
      const declares = new Set<string>();
      for (const candidate of servers) {
        const runtime = createPluginRequestRuntime(c, admission, bearer, {
          hostId: body.hostId,
          serverId: candidate.serverId,
        });
        try {
          const catalog = await runtime.catalog(signal);
          if (
            catalog.tools.some(
              (tool) =>
                tool.name === link.toolName &&
                pluginEntrypointKinds(tool).includes("global"),
            )
          )
            declares.add(candidate.serverId);
        } finally {
          await runtime.release();
        }
      }
      target = selectPluginDeepLinkServer(servers, (candidate) =>
        declares.has(candidate.serverId),
      );
    }
    return c.json({
      serverId: target.serverId,
      toolName: link.toolName,
      url: link.url,
    });
  }),
);

/**
 * Keep a writable file viewer's file grant with its lease, so its unsaved
 * App state survives a long session. The same grant is extended in place
 * (same URI, same writable state and ETag semantics); a lost one is
 * replaced in place by a new grant bound to the same instance. Every
 * renewal re-checks the actor, the allowed roots or Computer target, the
 * listed file and the client's File resources toggle. When the grant can't
 * be kept, the App stays open: this returns the Logs entries saying why
 * saving is off, and each refused save says so too.
 */
async function renewFileGrant(
  c: Context,
  body: z.infer<typeof handleSchema>,
  context: Pick<Awaited<ReturnType<typeof admitted>>, "admission" | "bearer" | "actor">,
  viewer: { file: string; serverId: string },
): Promise<PluginDiagnostic[]> {
  let access: Awaited<ReturnType<typeof fileAccess>> | undefined;
  try {
    access = await fileAccess(c, { ...body, params: undefined }, context);
    const { instance, lifetime } = access;
    await access.run(() =>
      ownedFileResources.renew(instance, lifetime, c.req.raw.signal),
    );
    return [];
  } catch (error) {
    if (isAbortError(error)) throw error;
    const code =
      error instanceof PluginInvocationError ||
      error instanceof ResourceGrantError ||
      error instanceof PluginFileTargetRefusal ||
      error instanceof PluginWorkspaceAdmissionError
        ? error.code
        : "RESOURCE_DENIED";
    return [
      {
        ...pluginDiagnostic(
          "warning",
          code,
          `Saving paused: ${viewer.file}`,
          `MCPJam couldn't keep ${viewer.file} open for saving. ${
            describePluginError(code) ?? code
          } The viewer stays open with its unsaved changes.`,
          { file: viewer.file },
        ),
        serverId: viewer.serverId,
      },
    ];
  } finally {
    await access?.runtime.release();
  }
}

/** Lease renewal for a retained App: same instance, same activation. */
instances.post("/renew", (c) =>
  route(c, async () => {
    const body = handleSchema.parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    let writableFile: { file: string; serverId: string } | undefined;
    const renewed = await pluginInstances.renewPersistent(
      body.instanceToken,
      actor,
      c.req.raw.signal,
      (instance) => {
        const file = instance.activation?.file;
        writableFile = file?.localTarget
          ? { file: file.name, serverId: instance.owner.serverId }
          : undefined;
        return assertPluginInstanceBindingCurrent({
          admission,
          bearer,
          instance,
          signal: c.req.raw.signal,
        });
      },
    );
    const diagnostics = writableFile
      ? await renewFileGrant(c, body, { admission, bearer, actor }, writableFile)
      : [];
    return c.json({
      status: renewed.renewed ? "renewed" : "unchanged",
      expiresAt: renewed.expiresAt,
      ...(diagnostics.length ? { diagnostics } : {}),
    });
  }),
);
instances.post("/close", (c) =>
  route(c, async () => {
    const body = handleSchema.parse(await c.req.json());
    const { bearer, identity } = await scope(c, body);
    const actorId = await resolvePluginCleanupActor({
      bearer,
      signal: c.req.raw.signal,
    });
    await pluginInstances.closePersistent(
      body.instanceToken,
      { ...identity, actorId },
      c.req.raw.signal,
    );
    return c.json({ status: "closed" });
  }),
);
instances.post("/form-preview", (c) =>
  route(c, async () => {
    const body = pluginFormPreviewRequestSchema.parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    const result = await readPluginFormResourcePreview({
      actor,
      bearer,
      sourceToken: body.sourceToken,
      parent: body.parent,
      target: body.target,
      signal: c.req.raw.signal,
      runtime: (instance) =>
        createPluginRequestRuntime(
          c,
          admission,
          bearer,
          { hostId: instance.hostId, serverId: instance.owner.serverId },
          instance,
        ),
    });
    return c.json(result);
  }),
);
instances.post("/form-preview/app/open", (c) =>
  route(c, async () => {
    const body = pluginFormPreviewRequestSchema.parse(await c.req.json());
    const { admission, bearer, actor } = await admitted(c, body);
    return c.json(
      await openPluginFormAppPreview({
        actor,
        bearer,
        sourceToken: body.sourceToken,
        parent: body.parent,
        target: body.target,
        signal: c.req.raw.signal,
        runtime: (instance) =>
          createPluginRequestRuntime(
            c,
            admission,
            bearer,
            { hostId: instance.hostId, serverId: instance.owner.serverId },
            instance,
            { ownedForms: false },
          ),
      }),
    );
  }),
);
for (const action of ["execute", "call-tool"] as const)
  instances.post(`/form-preview/app/${action}`, (c) =>
    route(c, async () => {
      const raw = await c.req.json();
      const call = action === "call-tool" ? callSchema.parse(raw) : undefined;
      const body = call ?? executeSchema.parse(raw);
      const { admission, bearer, actor } = await admitted(c, body);
      const current = getPluginFormApp({
        actor,
        bearer,
        token: body.instanceToken,
        signal: c.req.raw.signal,
        runtime: (instance) =>
          createPluginRequestRuntime(
            c,
            admission,
            bearer,
            { hostId: instance.hostId, serverId: instance.owner.serverId },
            instance,
            { ownedForms: false },
          ),
      });
      const origin = action === "execute" ? "entrypoint" : "app";
      const invocationId = call?.invocationId ?? current.child.operationId;
      const params = call?.params ?? {
        name: current.target.name,
        arguments: current.target.arguments ?? {},
      };
      return await invokePluginRequest(c, {
        actor,
        owner: current.service.source.owner,
        admission,
        runtime: current.service.runtime,
        resolve: current.resolve,
        assertOrigin: (resolved) => {
          current.service.assertLive();
          if (
            origin === "app" &&
            (!resolved.appToolsEnabled ||
              !getToolVisibility(resolved.tool._meta).includes("app"))
          )
            throw denied();
          pluginToolCallValidation(
            resolved.tool,
            params.arguments ?? {},
            denied,
          );
        },
        assertLive: current.service.assertLive,
        origin,
        invocationId,
        params,
        approval: body.approval,
        invoke: (ports, next) =>
          current.child.invoker.invoke(
            ports,
            origin,
            invocationId,
            next,
            current.service.signal,
          ),
      });
    }),
  );
instances.post("/form-files/services", (c) =>
  route(c, async () => {
    c.header("cache-control", "no-store");
    const body = pluginFormServiceRequestSchema.parse(await c.req.json());
    const { bearer, admission, actor } = await admitted(c, body);
    return c.json(
      await describePluginFormFiles({
        ...body,
        bearer,
        actor,
        signal: c.req.raw.signal,
        runtime: (instance) =>
          createPluginRequestRuntime(
            c,
            admission,
            bearer,
            { hostId: instance.hostId, serverId: instance.owner.serverId },
            instance,
          ),
      }),
    );
  }),
);
instances.use("/form-files/upload", bodyLimit({ maxSize: 1024 * 1024 }));
instances.post("/form-files/upload", (c) =>
  route(c, async () => {
    c.header("cache-control", "no-store");
    const form = await c.req.formData();
    let invalidKey = false;
    form.forEach((_value, key) => {
      if (key !== "request" && key !== "files") invalidKey = true;
    });
    if (invalidKey || form.getAll("request").length !== 1) throw denied();
    const metadata = form.get("request");
    if (typeof metadata !== "string" || metadata.length > 16 * 1024)
      throw denied();
    const body = pluginFormFileUploadRequestSchema.parse(JSON.parse(metadata));
    const files = form.getAll("files");
    if (
      !files.length ||
      files.length > PLUGIN_FORM_FILE_MAX_COUNT ||
      (body.relativePaths && body.relativePaths.length !== files.length) ||
      files.some(
        (file) =>
          typeof file === "string" || file.size > PLUGIN_FORM_FILE_MAX_BYTES,
      )
    )
      throw denied();
    const { bearer, admission, actor } = await admitted(c, body);
    return c.json(
      await uploadPluginFormFiles({
        ...body,
        bearer,
        actor,
        signal: c.req.raw.signal,
        files: await Promise.all(
          files.map(async (file, index) => {
            if (typeof file === "string") throw denied();
            return {
              name: file.name,
              type: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
              ...(body.relativePaths
                ? { relativePath: body.relativePaths[index] }
                : {}),
            };
          }),
        ),
        runtime: (instance) =>
          createPluginRequestRuntime(
            c,
            admission,
            bearer,
            { hostId: instance.hostId, serverId: instance.owner.serverId },
            instance,
          ),
      }),
    );
  }),
);

export default instances;
