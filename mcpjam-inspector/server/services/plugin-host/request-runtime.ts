import type { ElicitResult } from "@modelcontextprotocol/client";
import { pluginLocalFormFilesOptInSchema } from "../../../shared/plugin-form-services.js";
import { pluginFormFileGrants } from "./form-file-grants.js";
import { isLocalPluginFormFileTarget } from "./form-files.js";
import { PluginInvocationSuspension } from "./invocation.js";
import {
  createOwnedPluginMrtr,
  endPluginMrtrFormsDisabled,
} from "./owned-mrtr.js";
import {
  createOwnedPluginLegacyForms,
  legacyPluginFormWire,
  ownedLegacyFormCapabilities,
} from "./owned-legacy.js";
import { pluginFormSources } from "./form-sources.js";
import { pluginInstances } from "./instances.js";
import type {
  ResolvedInvocationContext,
  PluginToolCallParams,
  PluginContinuationSubmission,
} from "./invocation.js";
import {
  pluginModelContextEnabled,
  pluginMessageEnabled,
} from "./context-profile.js";
import { pluginComputerUploadsAvailable } from "./computer-file-target.js";
import {
  PLUGIN_FILE_TARGETS_EXTENSION,
  PLUGIN_LOCAL_FILE_ROOTS_ENV,
  pluginFileTargets,
} from "./file-targets.js";
import { pluginAppToolsEnabled } from "../../../shared/plugin-app-capabilities.js";
import type { Context } from "hono";
import {
  createPluginCapabilityRegistry,
  disabledPluginFeatures,
} from "@mcpjam/sdk/internal/plugin-host";
import {
  resolvePluginExtensions,
  type PluginExtensionCapabilities,
  type ResolvedPluginExtensions,
} from "@mcpjam/sdk/host-config/internal";
import type { MrtrInputCollector } from "@mcpjam/sdk";
import {
  OPENAI_LEGACY_FORM_EXTENSION,
  OPENAI_LEGACY_FORM_METHOD,
  openAILegacyFormSchemas,
} from "../../../shared/plugin-extensions/wire.js";
import {
  PLUGIN_CONNECTION_WAIT_MS,
  pluginConnectionPool,
  type PluginConnectionHooks,
  type PooledPluginConnection,
} from "./connection-pool.js";
import { timedPluginStep } from "./timing.js";
import { HOSTED_MODE, WEB_CALL_TIMEOUT_MS } from "../../config.js";
import { buildHostConnectionPins } from "../host-connection-pins.js";
import {
  createManualHostedConnection,
  projectServerSchema,
} from "../../routes/web/auth.js";
import {
  readPluginExecutionContext,
  registerPluginAdmissionResolver,
  assertPluginWorkspaceRuntime,
  type PluginWorkspaceAdmission,
} from "./admission.js";
import {
  pluginBindingDigest,
  pluginHostBindingDigest,
  pluginServerBindingDigest,
} from "./bindings.js";
import type {
  PluginPreviewInstance,
  PluginInstanceAdmissionRead,
} from "./instances.js";
import { PluginInvocationError, withPluginDiagnostic } from "./invocation.js";
import type { PluginDiagnostic } from "../../../shared/plugin-diagnostics.js";

const denied = () => new PluginInvocationError("INSTANCE_DENIED");
const FORMS_DISABLED_TITLE =
  "Form cancelled: Forms is turned off for this client";

/** The client's per-extension setting (mcpProfile.apps.pluginExtensions),
 * resolved with its style default. One answer for client and server. */
export function pluginHostExtensions(config: unknown): ResolvedPluginExtensions {
  return resolvePluginExtensions(
    (config && typeof config === "object" ? config : {}) as Parameters<
      typeof resolvePluginExtensions
    >[0],
  );
}

/** Which toggle governs each App entrypoint kind. Quick actions run from the
 * sidebar App rows. These are LAUNCHER toggles: they decide whether a new
 * App of that kind may open (its launchers, file-open routing, activation
 * admission), never whether an App that is already open keeps working. */
export const PLUGIN_ENTRYPOINT_EXTENSIONS = {
  thread: "conversationPanels",
  global: "sidebarApps",
  "quick-action": "sidebarApps",
  file: "fileViewers",
} as const satisfies Record<string, keyof PluginExtensionCapabilities>;
const PLUGIN_LAUNCHER_EXTENSIONS: ReadonlySet<keyof PluginExtensionCapabilities> =
  new Set(Object.values(PLUGIN_ENTRYPOINT_EXTENSIONS));

/** Server-side enforcement of a per-client extension toggle. */
export function assertPluginExtensionEnabled(
  extensions: Pick<ResolvedPluginExtensions, "capabilities">,
  key: keyof PluginExtensionCapabilities,
) {
  if (!extensions.capabilities[key])
    throw new PluginInvocationError("PLUGIN_EXTENSION_DISABLED");
}

/** The capability that governs a retained owner by its activation kind.
 * Only a settings control has one: its every request is a settings request.
 * Launcher kinds have none (see `PLUGIN_ENTRYPOINT_EXTENSIONS`). */
const PLUGIN_INSTANCE_EXTENSIONS: Readonly<
  Record<string, keyof PluginExtensionCapabilities>
> = { settings: "settings" };
type RetainedActivation = {
  activation?: { selector: { kind: string } };
};
export function pluginInstanceExtension(instance: RetainedActivation) {
  const kind = instance.activation?.selector.kind;
  return kind ? PLUGIN_INSTANCE_EXTENSIONS[kind] : undefined;
}

/** A retained owner's binding excludes the client's extension toggles
 * (`pluginHostBindingDigest`), so every request on it reads the CURRENT
 * ones. The master switch off refuses every retained App. A capability that
 * governs the owner itself (settings, mentions) off refuses it. A launcher
 * toggle never does: it gates new opens only, so an App already open keeps
 * its requests and renewal until it is closed. Feature routes check their
 * own capability per request (context, messages, files, forms, links…). */
export function assertPluginRetainedExtensions(
  config: unknown,
  extension: keyof PluginExtensionCapabilities | undefined,
) {
  const extensions = pluginHostExtensions(config);
  if (!extensions.enabled)
    throw new PluginInvocationError("PLUGIN_EXTENSION_DISABLED");
  if (extension && !PLUGIN_LAUNCHER_EXTENSIONS.has(extension))
    assertPluginExtensionEnabled(extensions, extension);
  return extensions;
}

/** Project a tool from this resolution's freshly admitted catalog. This creates
 * no retained authority; the next admission must fetch its own catalog. */
export function resolvePluginCatalogTool<
  T extends {
    tools: readonly { name: string }[];
    hostRevision: string;
    bindingId: string;
    serverIdentity: unknown;
    serverCapabilities?: unknown;
  },
>(catalog: T, name: string) {
  const { tools, serverCapabilities: _capabilities, ...current } = catalog;
  const tool = tools.find((candidate) => candidate.name === name) as
    | T["tools"][number]
    | undefined;
  if (!tool) throw new PluginInvocationError("INSTANCE_TOOL_UNAVAILABLE");
  return {
    ...current,
    tool,
    revision: pluginBindingDigest([
      current.hostRevision,
      current.bindingId,
      current.serverIdentity,
      tool,
    ]),
  };
}

/** One batched backend read proving the actor is still admitted and the
 * instance's saved host and server identity are unchanged. It opens no MCP
 * connection and grants no tool authority; it is a lease-renewal fence. */
export async function assertPluginInstanceBindingCurrent(input: {
  admission: PluginWorkspaceAdmission;
  bearer: string;
  instance: Pick<PluginPreviewInstance, "hostId" | "hostRevision" | "serverIdentity" | "owner"> &
    RetainedActivation;
  signal: AbortSignal;
}) {
  const { admission, bearer, instance, signal } = input;
  const current = await readPluginExecutionContext({
    projectId: admission.projectId,
    expectedActorId: admission.actorId,
    bearer,
    serverIds: [instance.owner.serverId],
    hostId: instance.hostId,
    signal,
  });
  signal.throwIfAborted();
  if (
    !current.hostConfig ||
    pluginHostBindingDigest(current.hostConfig) !== instance.hostRevision
  )
    throw new PluginInvocationError("INSTANCE_HOST_CHANGED");
  if (
    pluginBindingDigest(current.serverBindings.get(instance.owner.serverId)) !==
    pluginBindingDigest(instance.serverIdentity)
  )
    throw new PluginInvocationError("INSTANCE_SERVER_CHANGED");
  // Renewal never outlives the master switch (or a settings control's own
  // capability). A launcher toggle off keeps an open App renewing.
  assertPluginRetainedExtensions(
    current.hostConfig,
    pluginInstanceExtension(instance),
  );
}

/** Each HTTP request owns its connections; the retained instance owns no bearer. */
export function createPluginRequestRuntime(
  c: Context,
  admission: PluginWorkspaceAdmission,
  bearer: string,
  binding: { hostId: string; serverId: string },
  expected?: Pick<
    PluginPreviewInstance,
    "hostRevision" | "serverIdentity" | "owner" | "subject"
  > &
    RetainedActivation,
  options: {
    ownedForms?: boolean;
    /** The extension governing a retained owner that has no activation
     * (a mention lease). An App's own kind decides it otherwise. */
    extension?: keyof PluginExtensionCapabilities;
  } = {},
) {
  const governing =
    options.extension ?? (expected ? pluginInstanceExtension(expected) : undefined);
  type Lease = PooledPluginConnection<
    Awaited<ReturnType<typeof createManualHostedConnection>>["manager"]
  >;
  // This request's identity as a pool lessee. Leases are exclusive.
  const lessee = {};
  let lease: Lease | undefined;
  let disposed = false;
  // Owned form services belong to this request (its bearer, signal and
  // instance owner), never to the pooled connection.
  let formServices = false;
  let mrtr: ReturnType<typeof createOwnedPluginMrtr> | undefined;
  let forms: ReturnType<typeof createOwnedPluginLegacyForms> | undefined;
  let admittedServerName: string | undefined;
  // The client's toggles as of this request's latest fresh admission read.
  // Capability toggles are outside the binding, so each use re-reads them.
  let latest: ResolvedPluginExtensions | undefined;
  let mrtrWire = false;
  // An unpinned client prepares both form services and answers with the one
  // its connection actually negotiated; a pin decides it before connect.
  let negotiatedWire: "legacy" | "mrtr" | undefined;
  const ownedForms = () => (negotiatedWire === "mrtr" ? undefined : forms);
  const ownedMrtr = () => (negotiatedWire === "legacy" ? undefined : mrtr);
  const formsEnabled = () => latest?.capabilities.forms !== false;
  // Logs entries this request owes the client (returned with its response).
  const notes: PluginDiagnostic[] = [];
  const attach = (entry: Lease) => {
    const legacy = ownedForms();
    const modern = ownedMrtr();
    entry.hooks.legacy = legacy ? legacy.binding.handler : undefined;
    entry.hooks.collector = modern
      ? (modern.collector as NonNullable<typeof entry.hooks.collector>)
      : undefined;
  };
  const dropLease = async (reusable: boolean) => {
    const previous = lease;
    lease = undefined;
    if (previous) await pluginConnectionPool.release(previous, lessee, reusable);
  };
  const disconnect = async () => {
    // The pool closes the connection instead when it is no longer connected.
    await dropLease(true);
    await forms?.dispose();
    forms = undefined;
    mrtr = undefined;
  };
  const directRead: PluginInstanceAdmissionRead = (read) => read();
  type Tool = Awaited<
    ReturnType<Lease["manager"]["listTools"]>
  >["tools"][number];
  // The declarations this request listed on its lease (see `connect`).
  let listed: { lease: Lease; tools: Map<string, Tool> } | undefined;
  /** A form step: a human could act before the next resolution, which must
   * therefore read everything again, its catalog included. */
  const humanInput = () => {
    listed = undefined;
  };
  const connect = async (
    signal: AbortSignal,
    read: PluginInstanceAdmissionRead = directRead,
    /** The tool a resolution looks for: it may stand on this request's
     * listing of it (see below). Catalog reads pass none. */
    reuseName?: string,
  ) => {
    if (disposed) throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
    signal.throwIfAborted();
    // Host policy, actor/member/rollout and exact saved server identities are
    // projected in one atomic backend read. Target credentials are authorized
    // separately below; neither this snapshot nor a connection is a grant.
    const {
      hostConfig: config,
      serverBindings,
      serverNamesById,
    } = await read(() =>
      timedPluginStep("backend-admission-read", () =>
        readPluginExecutionContext({
          projectId: admission.projectId,
          expectedActorId: admission.actorId,
          bearer,
          serverIds: [binding.serverId],
          hostId: binding.hostId,
          signal,
        }),
      ),
    );
    signal.throwIfAborted();
    admittedServerName = serverNamesById[binding.serverId];
    if (!config) throw denied();
    if (
      config.hostId !== binding.hostId ||
      config.executionScope?.kind !== "project" ||
      config.executionScope.projectId !== admission.projectId
    )
      throw denied();
    assertPluginWorkspaceRuntime({
      harness: config.harness,
      hostPolicy: { hostStyle: config.hostStyle },
    });
    const hostRevision = pluginHostBindingDigest(config);
    if (expected && hostRevision !== expected.hostRevision)
      throw new PluginInvocationError("INSTANCE_HOST_CHANGED");
    const serverIdentity = serverBindings.get(binding.serverId)!;
    if (
      expected &&
      pluginBindingDigest(serverIdentity) !==
        pluginBindingDigest(expected.serverIdentity)
    )
      throw new PluginInvocationError("INSTANCE_SERVER_CHANGED");
    const pins = buildHostConnectionPins(config, WEB_CALL_TIMEOUT_MS);
    const version =
      pins.mcpProtocolVersionsByServerId?.[binding.serverId] ??
      pins.initializePins?.mcpProtocolVersion;
    const extensions = expected
      ? assertPluginRetainedExtensions(config, governing)
      : pluginHostExtensions(config);
    latest = extensions;
    mrtrWire = version === "2026-07-28";
    const capabilities = createPluginCapabilityRegistry({
      profile: {
        runtime: config.harness === "codex" ? "codex" : "chatgpt-emulated",
        transport: version === "2026-07-28" ? "mrtr" : "legacy",
        // The client's own per-extension toggles are the only source of
        // extension support, enforced here too, not only in the browser.
        // Neither hostContext.platform (a responsive-design hint for Apps)
        // nor the deployment decides it; features that need local resources
        // refuse with their own described errors where they run.
        disabledFeatures: disabledPluginFeatures(extensions.capabilities),
      },
      executionEnabled: () => true,
      bindings: {},
      services: {},
    });
    const assertCurrent = async () => {
      // Every form step re-reads here; a person may be acting on the form.
      humanInput();
      signal.throwIfAborted();
      if (!expected) throw denied();
      pluginInstances.getFormOwner(expected.owner, {
        ...expected.owner,
        subject: expected.subject,
      });
      await admission.revalidate({ signal });
      const fresh = await readPluginExecutionContext({
        projectId: admission.projectId,
        expectedActorId: admission.actorId,
        bearer,
        serverIds: [binding.serverId],
        hostId: binding.hostId,
        signal,
      });
      admittedServerName = fresh.serverNamesById[binding.serverId];
      if (
        pluginHostBindingDigest(fresh.hostConfig) !== hostRevision ||
        pluginBindingDigest(fresh.serverBindings.get(binding.serverId)) !==
          pluginBindingDigest(serverIdentity)
      )
        throw denied();
      // The same fresh read carries the client's current capability toggles
      // (Forms, File resources), which every form step re-checks.
      latest = assertPluginRetainedExtensions(fresh.hostConfig, governing);
      return latest;
    };
    const profile = config.mcpProfile as
      | { profileVersion?: unknown; extensions?: Record<string, unknown> }
      | undefined;
    const targets = pluginLocalFormFilesOptInSchema.safeParse(
      profile?.extensions?.["mcpjam/plugin-local-form-files"],
    );
    const localFiles = () =>
      profile?.profileVersion === 1 &&
      targets.success &&
      targets.data.serverIds.includes(binding.serverId) &&
      isLocalPluginFormFileTarget(
        lease?.manager.getServerConfig(binding.serverId),
      );
    // Hosted, with the server running on the project's Computer: uploads are
    // placed on that VM, where the server reads them.
    const computerUploads = () =>
      pluginComputerUploadsAvailable({
        hosted: HOSTED_MODE,
        computer: !!config.computer,
        transport: lease?.transport,
      });
    const uploadTarget = () =>
      localFiles()
        ? ("local-stdio" as const)
        : computerUploads()
          ? ("computer" as const)
          : undefined;
    // The advertised form protocol depends on the host and wire version only,
    // so every request for this binding shares one connection. Handlers answer
    // only for a request that owns an instance; otherwise they refuse.
    // An unpinned client (the Codex and ChatGPT templates both are)
    // negotiates its era at connect (`auto`): both handlers are installed
    // before connect, the legacy claim is withheld again on a 2026 era
    // (`legacyClaim`), and the negotiated era selects which service answers.
    // The standard `elicitation.form` claim is the MRTR collector's: the SDK
    // keeps it off a 2025 `initialize` (no standard `elicitation/create`
    // handler is installed here) and advertises it once the era is modern.
    const formsMode =
      options.ownedForms === false || !extensions.capabilities.forms
        ? ("none" as const)
        : version === "2026-07-28"
          ? ("mrtr" as const)
          : version === undefined
            ? ("auto" as const)
            : legacyPluginFormWire(version)
              ? ("legacy" as const)
              : ("none" as const);
    const legacyForms = formsMode === "legacy" || formsMode === "auto";
    const modernForms = formsMode === "mrtr" || formsMode === "auto";
    if (!formServices && expected && formsMode !== "none") {
      formServices = true;
      forms =
        legacyForms
          ? createOwnedPluginLegacyForms({
              bearer,
              projectId: admission.projectId,
              workspaceId: expected.owner.workspaceId,
              hostId: binding.hostId,
              hostRevision,
              serverId: binding.serverId,
              serverName: () => admittedServerName,
              signal,
              manager: () => lease?.manager,
              profile: () => ({
                fileResources: (latest ?? extensions).capabilities
                  .fileResources,
                origin: "server",
                userResources: !!uploadTarget(),
                userResourceKinds: uploadTarget() ? ["file", "directory"] : [],
                previews: true,
                previewKinds: ["resource_link", "mcp_app_tool"],
              }),
              assertCurrent,
              bindForm: async (input) => {
                humanInput();
                // Just after this form's own fresh admission read: a form
                // asked for while Forms is off is never shown. The server
                // gets a cancel, and the client's Logs say why.
                if (!formsEnabled()) {
                  const refusal = withPluginDiagnostic(
                    new PluginInvocationError("PLUGIN_FORMS_DISABLED"),
                    binding.serverId,
                    FORMS_DISABLED_TITLE,
                  );
                  notes.push(...(refusal.diagnostics ?? []));
                  throw refusal;
                }
                const source = {
                  owner: input.authorization.owner,
                  hostId: binding.hostId,
                  hostRevision,
                  invocationId: input.invocationId,
                  origin: input.authorization.origin,
                  revision: input.authorization.revision,
                  toolName: input.authorization.tool.name,
                  parent: {
                    kind: "legacy" as const,
                    id: input.rendezvousId,
                    round: 0 as const,
                  },
                  requestedSchema: input.schema,
                  expiresAt: input.expiresAt,
                  fileResources: (latest ?? extensions).capabilities
                    .fileResources,
                  ...(uploadTarget() ? { uploadTarget: uploadTarget() } : {}),
                };
                const handle = pluginFormSources.bind(source);
                return {
                  ...handle,
                  deliver: async (result) => {
                    await assertCurrent();
                    input.signal.throwIfAborted();
                    pluginFormSources.get(
                      handle.token,
                      source.owner,
                      source.parent,
                    );
                    // The client's CURRENT Forms toggle decides delivery.
                    // Off: the answer is never sent; the form ends as
                    // cancelled, once, and the client's Logs say why.
                    if (!formsEnabled() && result.action !== "cancel") {
                      notes.push(
                        ...(withPluginDiagnostic(
                          new PluginInvocationError("PLUGIN_FORMS_DISABLED"),
                          binding.serverId,
                          FORMS_DISABLED_TITLE,
                        ).diagnostics ?? []),
                      );
                      return { action: "cancel" } as ElicitResult;
                    }
                    if (result.action !== "accept" || !source.uploadTarget)
                      return result;
                    if (uploadTarget() !== source.uploadTarget) throw denied();
                    const prepared = pluginFormFileGrants.prepareDelivery(
                      source,
                      handle.token,
                      result.content ?? {},
                    );
                    // Uploaded selections need the client's current permission,
                    // even when the upload happened before the toggle changed.
                    // Explicit resource options and ordinary answers still work.
                    if (
                      source.origin === "app" &&
                      !(latest ?? extensions).capabilities.fileResources &&
                      prepared.hasUploads
                    ) {
                      const refusal = withPluginDiagnostic(
                        new PluginInvocationError(
                          "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
                        ),
                        binding.serverId,
                        "Form submission refused: File resources is turned off for this client",
                      );
                      notes.push(...(refusal.diagnostics ?? []));
                      throw refusal;
                    }
                    prepared.assertReady();
                    prepared.commit();
                    return {
                      ...result,
                      content: prepared.content,
                    } as ElicitResult;
                  },
                };
              },
            })
          : undefined;
      mrtr =
        modernForms
          ? createOwnedPluginMrtr({
              c,
              bearer,
              projectId: admission.projectId,
              serverId: binding.serverId,
              manager: () => lease?.manager,
              assertCurrent,
              sourceBinding: { hostId: binding.hostId, hostRevision },
              localFiles,
              uploadTarget,
              fileResources: extensions.capabilities.fileResources,
              formsEnabled,
            })
          : undefined;
    }
    const clientCapabilities = {
      ...ownedLegacyFormCapabilities(
        capabilities.clientCapabilities(),
        legacyForms ? { binding: true } : undefined,
      ),
      ...(modernForms ? { elicitation: { form: {} } } : {}),
    };
    const key = pluginBindingDigest([
      "plugin-connection-v1",
      admission.actorId,
      admission.projectId,
      binding.hostId,
      binding.serverId,
      hostRevision,
      pluginBindingDigest(serverIdentity),
      clientCapabilities,
      formsMode,
    ]);
    // Reuse this request's own lease, or an idle pooled connection for the
    // same key. A changed key (host, identity or capabilities) never reuses.
    let candidate: Lease | undefined =
      lease && lease.key === key && !lease.closed ? lease : undefined;
    if (!candidate && lease) await dropLease(true);
    // Another request of this actor and binding may be finishing on the
    // pooled connection (the App's first call during its activation): wait
    // briefly for it rather than authorize and initialize a second one.
    candidate ??= await pluginConnectionPool.acquireWithin<Lease["manager"]>(
      key,
      lessee,
      PLUGIN_CONNECTION_WAIT_MS,
      signal,
    );
    if (disposed) {
      if (candidate)
        await pluginConnectionPool.release(candidate, lessee, true);
      throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
    }
    if (candidate) lease = candidate;
    signal.throwIfAborted();
    const sameBinding =
      !!candidate &&
      (!expected || candidate.bindingId === expected.owner.bindingId);
    /** FULL target and credential authorization (no MCP initialize). */
    const authorizeTarget = (hooks: PluginConnectionHooks) =>
      createManualHostedConnection(
        c,
        projectServerSchema.parse({
          projectId: admission.projectId,
          serverId: binding.serverId,
        }),
        projectServerSchema,
        {
          lazyConnect: true,
          extensionRequestHandlers: legacyForms
            ? {
                [binding.serverId]: [
                  {
                    method: OPENAI_LEGACY_FORM_METHOD,
                    schemas: openAILegacyFormSchemas,
                    waitsForInput: true,
                    legacyClaim: OPENAI_LEGACY_FORM_EXTENSION,
                    handler: async (request: {
                      params?: Record<string, unknown>;
                    }) => {
                      const handler = hooks.legacy;
                      if (!handler) throw denied();
                      return handler(request);
                    },
                  },
                ],
              }
            : undefined,
          hostConfig: { ...config, clientCapabilities },
        },
      );
    const authorizationOf = (
      created: Awaited<ReturnType<typeof authorizeTarget>>,
    ) => {
      const identity = created.authorizedServerIdentities?.[binding.serverId];
      return {
        target: created.authorizedServerConfigs?.[binding.serverId],
        // Hash only: no target credentials enter the retained instance or response.
        bindingId: pluginServerBindingDigest(identity),
        transport: (
          identity as { config?: { transportType?: unknown } } | undefined
        )?.config?.transportType as string | undefined,
      };
    };
    // Set when this call ran full target authorization or opened the MCP
    // session: long external work the caller reads again after.
    let cold = false;
    if (
      candidate &&
      sameBinding &&
      pluginConnectionPool.authorized(candidate)
    ) {
      // In active use: re-authorize ahead of the window, off this request's
      // critical path (connection-pool.ts). This request keeps standing on
      // the current authorization, which is still inside its window.
      const entry = candidate;
      const startedAt = pluginConnectionPool.beginRefresh(entry);
      if (startedAt !== undefined)
        void timedPluginStep("authorize-refresh", async () => {
          let authorization;
          try {
            const created = await authorizeTarget({});
            // The refresh only proves the target; its session is never used.
            await created.manager.disconnectAllServers().catch(() => {});
            authorization = authorizationOf(created);
          } catch {
            authorization = undefined;
          }
          pluginConnectionPool.endRefresh(entry, startedAt, authorization);
        });
    } else {
      cold = true;
      const hooks: PluginConnectionHooks = {};
      // A refused or changed full authorization retires the stale session:
      // no later request may reuse it.
      const retire = async () => {
        if (candidate && lease === candidate) await dropLease(false);
      };
      const created = await timedPluginStep("authorize-connection", () =>
        authorizeTarget(hooks),
      ).catch(async (error: unknown) => {
        await retire();
        throw error;
      });
      if (disposed || signal.aborted) {
        await created.manager.disconnectAllServers();
        signal.throwIfAborted();
        throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
      }
      let adopted: Lease | undefined;
      try {
        const { target, bindingId, transport } = authorizationOf(created);
        if (expected && bindingId !== expected.owner.bindingId) {
          throw new PluginInvocationError("INSTANCE_CONNECTION_CHANGED");
        }
        // FULL target/credential authorization just ran. Keep the live MCP
        // session only when the authorized target is unchanged.
        if (
          candidate &&
          pluginBindingDigest(candidate.target) === pluginBindingDigest(target) &&
          candidate.manager.getConnectionStatus(binding.serverId) ===
            "connected"
        ) {
          await created.manager.disconnectAllServers();
          pluginConnectionPool.reauthorized(
            candidate,
            target,
            bindingId,
            transport,
          );
        } else {
          await dropLease(false);
          signal.throwIfAborted();
          if (disposed)
            throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
          adopted = pluginConnectionPool.adopt(
            {
              key,
              serverId: binding.serverId,
              manager: created.manager,
              hooks,
              target,
              bindingId,
              transport,
            },
            lessee,
          );
          lease = adopted;
          attach(adopted);
          if (modernForms)
            created.manager.setMrtrInputCollector(
              binding.serverId,
              (args) => {
                const collect = hooks.collector as
                  | ((value: typeof args) => ReturnType<MrtrInputCollector>)
                  | undefined;
                if (!collect) return Promise.reject(denied());
                return collect(args);
              },
            );
          await timedPluginStep("mcp-connect", () =>
            created.manager.connectToServer(binding.serverId, target!, {
              signal,
            }),
          );
        }
      } catch (error) {
        if (!adopted) {
          await created.manager.disconnectAllServers();
          await retire();
        } else if (lease === adopted) await dropLease(false);
        throw error;
      }
    }
    signal.throwIfAborted();
    if (disposed || !lease)
      throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
    attach(lease);
    const manager = lease.manager;
    // A request's first resolution fetches a current catalog from the
    // admitted connection. A later one in the SAME request, on the same warm
    // lease, stands on the declaration that request listed: everything it
    // authorizes (actor, member, host, server, toggles, durable control) was
    // just read again above. A form shown since (a human could act during
    // it) drops the listing, as does any change of lease. Nothing listed is
    // ever kept beyond this request.
    const kept =
      reuseName !== undefined && !cold && listed?.lease === lease
        ? listed.tools.get(reuseName)
        : undefined;
    const initialCatalog = kept
      ? { tools: [kept], nextCursor: undefined }
      : await timedPluginStep("tools-list", () =>
          manager.listTools(binding.serverId, undefined, {
            signal,
            cacheMode: "bypass",
          }),
        );
    if (!kept) listed = undefined;
    signal.throwIfAborted();
    const negotiatedVersion = manager.getInitializationInfo(
      binding.serverId,
    )?.protocolVersion;
    if (version === undefined) {
      // Auto: the negotiated era, not the (absent) pin, selects the form
      // service that answers and dispatches on this connection.
      mrtrWire = negotiatedVersion === "2026-07-28";
      negotiatedWire = mrtrWire ? "mrtr" : "legacy";
      attach(lease);
    }
    const fileTargets = pluginFileTargets({
      contract: (
        config.mcpProfile?.extensions as Record<string, unknown> | undefined
      )?.[PLUGIN_FILE_TARGETS_EXTENSION],
      identity: {
        actorId: admission.actorId,
        projectId: admission.projectId,
        serverId: binding.serverId,
      },
      operatorRoots: process.env[PLUGIN_LOCAL_FILE_ROOTS_ENV],
      hosted: HOSTED_MODE,
      computer: !!config.computer,
      transport: lease.transport,
    });
    return {
      manager,
      initialCatalog,
      /** Full target authorization or MCP initialize ran in this call. */
      cold,
      /** The first page is this request's earlier listing, not a new one. */
      kept: !!kept,
      protocolVersion: negotiatedVersion,
      hostRevision,
      bindingId: lease.bindingId,
      serverIdentity,
      localFileTargetContract: fileTargets.contract,
      executionScope: config.executionScope,
      /** Form uploads for this server can be placed on the project's Computer. */
      computerUploads: computerUploads(),
      /** Where file targets live and, when unusable, why. */
      fileTargets: {
        placement: fileTargets.placement,
        ...(fileTargets.unavailable
          ? { unavailable: fileTargets.unavailable }
          : {}),
      },
      requiresApproval: config.requireToolApproval === true,
      appToolsEnabled: pluginAppToolsEnabled(config),
      contextEnabled:
        pluginModelContextEnabled(config) &&
        extensions.capabilities.modelContext,
      messageEnabled:
        pluginMessageEnabled(config) && extensions.capabilities.messages,
      extensions,
      runtime:
        config.harness === "codex" ? ("codex" as const) : ("chatgpt" as const),
      transport:
        negotiatedVersion === "2026-07-28"
          ? ("mrtr" as const)
          : ("legacy" as const),
    };
  };
  type Connection = Awaited<ReturnType<typeof connect>>;
  /** The connection facts a resolution reports (not how it got them). */
  type Admitted = Omit<Connection, "initialCatalog" | "cold" | "kept">;
  const verify = async (
    current: Admitted,
    signal: AbortSignal,
    read: PluginInstanceAdmissionRead = directRead,
  ) => {
    signal.throwIfAborted();
    if (disposed) throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
    const { hostConfig, serverBindings } = await read(() =>
      timedPluginStep("backend-admission-read", () =>
        readPluginExecutionContext({
          projectId: admission.projectId,
          expectedActorId: admission.actorId,
          bearer,
          serverIds: [binding.serverId],
          hostId: binding.hostId,
          signal,
        }),
      ),
    );
    signal.throwIfAborted();
    if (
      !hostConfig ||
      pluginHostBindingDigest(hostConfig) !== current.hostRevision
    )
      throw new PluginInvocationError("INSTANCE_HOST_CHANGED");
    if (expected) assertPluginRetainedExtensions(hostConfig, governing);
    const identity = serverBindings.get(binding.serverId)!;
    if (
      pluginBindingDigest(identity) !==
      pluginBindingDigest(current.serverIdentity)
    )
      throw denied();
    signal.throwIfAborted();
    if (disposed) throw new PluginInvocationError("INSTANCE_REQUEST_CLOSED");
  };
  let resolving = false;
  const owned = async <T>(effect: () => Promise<T>): Promise<T> => {
    if (resolving) throw new PluginInvocationError("INSTANCE_REQUEST_BUSY");
    resolving = true;
    try {
      return await effect();
    } finally {
      resolving = false;
    }
  };
  // The last admitted connection facts this request resolved, for the final
  // single-read fence. Never retained beyond this request.
  let lastAdmitted: Admitted | undefined;
  const resolve = (
    name: string,
    signal: AbortSignal,
    read: PluginInstanceAdmissionRead = directRead,
  ) =>
    owned(async () => {
      const { initialCatalog, cold, kept, ...current } = await connect(
        signal,
        read,
        name,
      );
      lastAdmitted = current;
      let cursor: string | undefined;
      const seen = new Set<string>();
      const listedOn = lease;
      for (let page = 0; page < 64; page++) {
        const catalog =
          page === 0
            ? initialCatalog
            : await current.manager.listTools(
                binding.serverId,
                { cursor },
                { signal, cacheMode: "bypass" },
              );
        signal.throwIfAborted();
        if (!kept && listedOn) {
          // Remember what this request listed, for its later resolutions.
          if (page === 0) listed = { lease: listedOn, tools: new Map() };
          for (const tool of catalog.tools)
            if (!listed!.tools.has(tool.name) && listed!.tools.size < 4096)
              listed!.tools.set(tool.name, tool);
        }
        const tool = catalog.tools.find((candidate) => candidate.name === name);
        if (tool) {
          // After a cold authorization or initialize (long external work),
          // read again before anything stands on this resolution.
          if (cold) await verify(current, signal, read);
          return resolvePluginCatalogTool({ ...current, tools: [tool] }, name);
        }
        if (typeof catalog.nextCursor !== "string") break;
        if (seen.has(catalog.nextCursor))
          throw new PluginInvocationError("INSTANCE_CATALOG_INVALID");
        seen.add(catalog.nextCursor);
        cursor = catalog.nextCursor;
      }
      throw new PluginInvocationError("INSTANCE_TOOL_UNAVAILABLE");
    });
  // Each resolution reads actor/member/rollout, host/server and the caller's
  // durable control (its `read` fence) before its catalog work, and again
  // after it when that work authorized or opened the connection cold. The
  // invoker can coalesce admission-only reads immediately adjacent to this
  // full resolution without retaining authority.
  registerPluginAdmissionResolver(resolve);
  /** Headless discovery shares exactly the same actor, installed version and target admission. */
  const catalog = (
    signal: AbortSignal,
    read: PluginInstanceAdmissionRead = directRead,
  ) =>
    owned(async () => {
      const {
        initialCatalog,
        cold,
        kept: _kept,
        ...current
      } = await connect(signal, read);
      lastAdmitted = current;
      if (!current.protocolVersion)
        throw new PluginInvocationError("INSTANCE_PROTOCOL_UNAVAILABLE");
      const tools: Awaited<
        ReturnType<Connection["manager"]["listTools"]>
      >["tools"] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 64; page++) {
        const result =
          page === 0
            ? initialCatalog
            : await current.manager.listTools(
                binding.serverId,
                { cursor },
                { signal, cacheMode: "bypass" },
              );
        signal.throwIfAborted();
        for (const tool of result.tools) {
          if (names.has(tool.name) || tools.length >= 4096)
            throw new PluginInvocationError("INSTANCE_CATALOG_INVALID");
          names.add(tool.name);
          tools.push(tool);
        }
        if (typeof result.nextCursor !== "string") {
          if (cold) await verify(current, signal, read);
          return {
            ...current,
            tools,
            serverCapabilities: current.manager.getServerCapabilities(
              binding.serverId,
            ),
          };
        }
        if (cursors.has(result.nextCursor))
          throw new PluginInvocationError("INSTANCE_CATALOG_INVALID");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new PluginInvocationError("INSTANCE_CATALOG_LIMIT");
    });
  return {
    resolve,
    /** ONE batched backend read after this request's last resolution: proves
     * the actor is still admitted (member, rollout) and the host and saved
     * server identity are unchanged. Replaces a separate admission
     * revalidation plus a full re-resolution at the end of a request. */
    verifyCurrent: (signal: AbortSignal) =>
      owned(async () => {
        if (!lastAdmitted) throw denied();
        await verify(lastAdmitted, signal);
      }),
    /** Related tools share one freshly admitted catalog, never a retained grant. */
    resolveTools: async (
      names: readonly string[],
      signal: AbortSignal,
      read: PluginInstanceAdmissionRead = directRead,
    ) => {
      if (!names.length || names.length > 64 || names.some((name) => !name))
        throw new PluginInvocationError("INSTANCE_CATALOG_INVALID");
      const admitted = await catalog(signal, read);
      return new Map(
        [...new Set(names)].map(
          (name) => [name, resolvePluginCatalogTool(admitted, name)] as const,
        ),
      );
    },
    catalog,
    collectOwnedMrtr: (
      args: Parameters<import("@mcpjam/sdk").MrtrInputCollector>[0],
    ) => {
      const mrtr = ownedMrtr();
      if (!mrtr)
        throw new PluginInvocationError("CONTINUATION_PROTOCOL_DENIED");
      return mrtr.collector(args);
    },
    runOwnedModern: (
      authorization: ResolvedInvocationContext,
      invocationId: string,
      params: PluginToolCallParams,
      signal: AbortSignal,
      run: () => Promise<unknown>,
    ) => {
      const mrtr = ownedMrtr();
      if (!mrtr)
        throw new PluginInvocationError("CONTINUATION_PROTOCOL_DENIED");
      return mrtr.execute(authorization, invocationId, params, signal, run);
    },
    handleLegacyForm: (request: { params?: Record<string, unknown> }) => {
      const forms = ownedForms();
      if (!forms) throw new PluginInvocationError("INSTANCE_DENIED");
      return forms.binding.handler(request);
    },
    runOwnedLegacy: async <T>(
      authorization: ResolvedInvocationContext,
      invocationId: string,
      signal: AbortSignal,
      run: () => Promise<T>,
    ) => {
      const forms = ownedForms();
      if (!forms || ownedMrtr())
        throw new PluginInvocationError("INSTANCE_DENIED");
      const result = await forms.run(authorization, invocationId, signal, run);
      pluginFormFileGrants.closeOperation(authorization.owner, invocationId);
      return result;
    },
    executeOwned: async (
      authorization: ResolvedInvocationContext,
      invocationId: string,
      params: PluginToolCallParams,
      signal: AbortSignal,
    ) => {
      const manager = lease?.manager;
      if (!manager)
        throw new PluginInvocationError("INSTANCE_CONNECTION_UNAVAILABLE");
      const mrtr = ownedMrtr();
      const forms = ownedForms();
      const execute = () =>
        manager.executeTool(
          binding.serverId,
          params.name,
          params.arguments ?? {},
          {
            metadata: params._meta,
            request: { signal },
            retry: { retries: 0, retryDelayMs: 0 },
          },
        );
      const result = await (mrtr
        ? mrtr.execute(authorization, invocationId, params, signal)
        : forms
        ? forms.run(authorization, invocationId, signal, execute)
        : execute());
      if (!(result instanceof PluginInvocationSuspension))
        pluginFormFileGrants.closeOperation(authorization.owner, invocationId);
      return result;
    },
    resumeMrtr: (
      authorization: ResolvedInvocationContext,
      invocationId: string,
      params: PluginToolCallParams,
      submission: PluginContinuationSubmission,
      signal: AbortSignal,
    ) => {
      const mrtr = ownedMrtr();
      if (!mrtr) {
        // Forms went off after this form was shown: this request installed
        // no form service, and the pending form ends as cancelled.
        if (expected && mrtrWire && !formsEnabled())
          return endPluginMrtrFormsDisabled({
            bearer,
            owner: authorization.owner,
            invocationId,
            continuationId: submission.continuationId,
            serverId: binding.serverId,
          });
        throw new PluginInvocationError("CONTINUATION_PROTOCOL_DENIED");
      }
      return mrtr.resume(
        authorization,
        invocationId,
        params,
        submission,
        signal,
      );
    },
    /** Logs entries for the client, returned with this request's response. */
    diagnostics: () => [...notes],
    release: async () => {
      disposed = true;
      await disconnect();
    },
    manager: () => lease?.manager,
  };
}
