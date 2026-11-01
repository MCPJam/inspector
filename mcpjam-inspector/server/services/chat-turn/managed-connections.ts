import { setManagerResourceHostConfig } from "../../utils/mcp-connections";
import { TurnResources } from "./resources.js";
import {
  createHarnessInputHost,
  harnessElicitationModes,
} from "../../utils/harness/input-host.js";
import { isForwardingOrganization } from "../../utils/harness/forwarding/native-turn.js";
import { chatTurnIsolatedServerIds } from "../../utils/plugin-server-isolation.js";
import {
  HOSTED_ELICITATION_VERSION,
  HOSTED_HARNESS_INPUT_VERSION,
} from "../../../shared/hosted-elicitation.js";
import { hasServiceCredential } from "../service-credential.js";
import { PluginInvocationError } from "../plugin-host/invocation.js";
import { describePluginError } from "../../../shared/plugin-diagnostics.js";
import { pluginHostBindingDigest } from "../plugin-host/bindings.js";
import { createModelMrtrAdapter } from "../plugin-host/model-mrtr.js";
import { parseMrtrChatResumeRequest } from "@/shared/mrtr-continuation";
import { installedFormClientCapabilities } from "../plugin-host/owned-legacy.js";
import {
  chatPluginFormPlan,
  pluginModelMrtrEnabled,
  chatPluginToolExecutor,
} from "../../routes/web/chat-v2-plugin-forms.js";
import {
  createModelFormDispatch,
  createModelFormExecutor,
} from "../plugin-host/model-forms.js";
import {
  admitPluginWorkspace,
  assertPluginWorkspaceRuntime,
} from "../plugin-host/admission.js";
import { parsePluginWorkspaceDescriptor } from "@/shared/plugin-workspace";
import { toolApprovalSubjectFromAuthHeader } from "../../utils/tool-approval-token.js";
import { buildHostConnectionPins } from "../host-connection-pins.js";
import { refreshConnectionProfiles } from "../../utils/connection-profile-refresh.js";
import { type Context } from "hono";
import { TaskCreatedSink } from "@mcpjam/sdk";
import {
  isCompatibleHostedTasksVersion,
  hostedTaskOwnerRequestId,
} from "@/shared/hosted-task-created";
import { HostedTaskCreatedBridge } from "../../utils/hosted-task-created-bridge.js";
import { recordHostedTask } from "../hosted-task-registry.js";
import { resolveToolTaskSeam } from "../../utils/task-seam.js";
import {
  ELICITATION_TIMEOUT_EXTENSION_MS,
  HOSTED_MODE,
  WEB_STREAM_TIMEOUT_MS,
  WEBMCP_INSPECTOR_ENABLED,
} from "../../config.js";
import {
  HostedElicitationBridge,
  hostDeclaresElicitation,
  resolveElicitationGate,
} from "../../routes/web/hosted-elicitation.js";
import { HostedMrtrBridge } from "../../utils/mrtr-hosted-bridge.js";
import {
  resolveMrtrChatResume,
  type MrtrEngineResume,
} from "../../utils/mrtr-hosted-chat.js";
import { HOSTED_MRTR_VERSION } from "@/shared/mrtr-continuation";
import {
  parseScopeStepUpCancelRequest,
  parseScopeStepUpResumeRequest,
} from "@/shared/scope-step-up";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  validateAppToolEntries,
  validatePageToolEntries,
  PageToolValidationError,
  type PageToolEntry,
  AppToolValidationError,
  validateWidgetModelContextEntries,
  WidgetModelContextValidationError,
} from "../../utils/chat-v2-orchestration.js";
import {
  createAuthorizedManager,
  buildServerNamesById,
  callerContextFromHono,
  ErrorCode,
  WebRouteError,
} from "../../routes/web/auth.js";
import { createHostedRpcLogCollector } from "../../routes/web/hosted-rpc-logs.js";
import { resolveXaaIssuer } from "../xaa-mint.js";
import { resolveMrtrAuthPrincipal } from "../../utils/mrtr-hosted-collector.js";
import {
  applyPluginExtensionsToClientCapabilities,
  resolvePluginExtensions,
} from "@mcpjam/sdk/host-config/internal";
import { resolveManagedTurnSetup } from "./managed-setup.js";
import { pendingStdioCommandApproval } from "../../utils/stdio-command-approvals.js";

type ManagedSetup = Extract<
  Awaited<ReturnType<typeof resolveManagedTurnSetup>>,
  { value: unknown }
>["value"];
export async function prepareManagedConnections(args: {
  c: Context;
  rawBody: Record<string, unknown>;
  bearerToken: string;
  rpcCollector: ReturnType<typeof createHostedRpcLogCollector>;
  resources: TurnResources;
  setup: Pick<
    ManagedSetup,
    | "hostedBody"
    | "initializePins"
    | "mcpProtocolVersionsByServerId"
    | "body"
    | "messages"
    | "selectedServerIds"
    | "selectedServerNames"
    | "scenarioId"
    | "accessVersion"
    | "surface"
    | "hostId"
    | "modelDefinition"
    | "turnMode"
    | "hostRuntimeConfig"
    | "isHostAuthoritative"
    | "effectiveServerIds"
    | "effectiveServerNames"
    | "xaaPolicy"
    | "effectiveInitializePins"
    | "resolvedExecution"
    | "turnRail"
    | "modelVisibleMcpToolResults"
    | "executionScope"
  >;
  onOAuthServerUrls: (urls: Record<string, string>) => void;
}) {
  const {
    c,
    rawBody,
    bearerToken,
    rpcCollector,
    resources,
    onOAuthServerUrls,
  } = args;
  let {
    hostedBody,
    mcpProtocolVersionsByServerId,
    body,
    selectedServerIds,
    selectedServerNames,
    scenarioId,
    hostId,
    accessVersion,
    modelDefinition,
    turnMode,
    hostRuntimeConfig,
    isHostAuthoritative,
    effectiveServerIds,
    effectiveServerNames,
    xaaPolicy,
    effectiveInitializePins,
    resolvedExecution,
    turnRail,
    modelVisibleMcpToolResults,
    executionScope,
  } = args.setup;

  const pluginWorkspace = parsePluginWorkspaceDescriptor(body.pluginWorkspace);
  const pluginExtensions = hostRuntimeConfig
    ? resolvePluginExtensions(
        hostRuntimeConfig as Parameters<typeof resolvePluginExtensions>[0],
      )
    : undefined;

  // Registering the callback is what makes the SDK advertise `elicitation`,
  // so "who declares it" and "may we honor it" are one decision — see
  // `resolveElicitationGate` for why scenario turns must not read the body.
  const { effectiveClientCapabilities, enabled: elicitationEnabled } =
    resolveElicitationGate({
      hostAuthoritative: isHostAuthoritative,
      hostClientCapabilities: hostRuntimeConfig?.clientCapabilities,
      bodyClientCapabilities: hostedBody.clientCapabilities,
      clientVersion: hostedBody.hostedElicitationVersion,
    });

  // ── Tasks (`com.mcpjam/tasks`) ──────────────────────────────────────────
  // Read from the RESOLVED host, never the body. Same authority rule as the
  // elicitation gate above: a share-link visitor owns the request body, so a
  // body-supplied opt-in must not be able to turn tasks on against a host
  // that said off. `tasksPolicy` is absent from `ExecutionOverrides`
  // entirely, so this holds at every precedence rather than by a check here.
  const tasksSink = new TaskCreatedSink();
  const tasksSeam = resolveToolTaskSeam({
    tasksPolicy: resolvedExecution.tasksPolicy,
    surface: "chat",
    scope: hostedBody.projectId,
    sink: tasksSink,
  });

  // ── Hosted MRTR (input_required, §12.5) gate + resume parse ─────────────
  // Standard elicitation and saved OpenAI plugin Forms are independent
  // declarations. Either installed consumer can drive MRTR; both require
  // the browser version handshake so stale clients fail closed. The plugin
  // workspace is admitted below before a manager is created. Emulated only:
  // BYOK (AI-SDK-owned loop) and harness (separate MCP plane) do not route a
  // suspend through this manager, so registering the collector there could
  // strand a round. `respectToolVisibility` is preserved across the retry
  // because the SAME manager (same advertised/gated tool set) drives it.
  const isEmulatedMcpjam =
    Boolean(modelDefinition.id) &&
    turnRail === "hosted" &&
    !resolvedExecution.harness;
  const rawMrtrVersion = (rawBody as Record<string, unknown>).hostedMrtrVersion;
  const mrtrEnabled =
    isEmulatedMcpjam &&
    rawMrtrVersion === HOSTED_MRTR_VERSION &&
    ((elicitationEnabled &&
      hostDeclaresElicitation(effectiveClientCapabilities)) ||
      pluginModelMrtrEnabled({
        emulated: isEmulatedMcpjam,
        workspace: !!pluginWorkspace && turnMode === "interactive",
        forms: pluginExtensions?.capabilities.forms,
        serviceCredential: hasServiceCredential(),
        elicitationHandshake:
          hostedBody.hostedElicitationVersion === HOSTED_ELICITATION_VERSION,
        mrtrHandshake: rawMrtrVersion === HOSTED_MRTR_VERSION,
      }));

  const rawMrtrResume = (rawBody as Record<string, unknown>).mrtrResume;
  const mrtrResumeRequest = parseMrtrChatResumeRequest(rawMrtrResume);
  if (rawMrtrResume !== undefined && !mrtrResumeRequest) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Malformed mrtrResume descriptor",
    );
  }
  if (mrtrResumeRequest && !mrtrEnabled) {
    // A resume for a continuation this turn cannot drive (version mismatch /
    // wrong engine) must fail fast rather than silently drop it.
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      "This turn cannot resume an MRTR continuation (version or engine mismatch)",
    );
  }
  const rawScopeStepUpResume = (rawBody as Record<string, unknown>)
    .scopeStepUpResume;
  const scopeStepUpResumeRequest =
    parseScopeStepUpResumeRequest(rawScopeStepUpResume);
  if (rawScopeStepUpResume !== undefined && !scopeStepUpResumeRequest) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Malformed scopeStepUpResume descriptor",
    );
  }
  const rawScopeStepUpCancel = (rawBody as Record<string, unknown>)
    .scopeStepUpCancel;
  const scopeStepUpCancelRequest =
    parseScopeStepUpCancelRequest(rawScopeStepUpCancel);
  if (rawScopeStepUpCancel !== undefined && !scopeStepUpCancelRequest) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Malformed scopeStepUpCancel descriptor",
    );
  }
  if (scopeStepUpResumeRequest && scopeStepUpCancelRequest) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Only one scope step-up continuation action is allowed",
    );
  }
  const scopeStepUpEnabled =
    typeof hostedBody.chatSessionId === "string" &&
    hostedBody.chatSessionId.length > 0;

  // Resolve the Convex-valid bearer once for both bridges (NOT the raw
  // Authorization header: WorkOS API-key callers send an `sk_…` key Convex
  // cannot verify; this resolves the delegated JWT and passes JWTs through).
  // `tasksSeam` is in the condition because the hosted task registry needs
  // the same bearer: the backend derives the row's owner from it. Without
  // this, a host with Tasks on but elicitation and MRTR off would resolve no
  // bearer, silently skip the registry consumer, and lose the cross-device
  // recovery index for exactly the ordinary task-only turns it is meant to
  // cover.
  const convexBearer =
    elicitationEnabled ||
    mrtrEnabled ||
    mrtrResumeRequest ||
    scopeStepUpEnabled ||
    scopeStepUpResumeRequest ||
    scopeStepUpCancelRequest ||
    tasksSeam
      ? await getConvexBearerForRequest(c)
      : undefined;
  const mrtrAuthPrincipal = resolveMrtrAuthPrincipal(c);

  // Cleanup runs in reverse, so the disconnect is owned BEFORE the bridge:
  // pending elicitation rows are withdrawn while the turn's connections are
  // still open, and no prompt stays answerable for a turn that has ended.
  let connectedManager: { disconnectAllServers(): Promise<void> } | undefined;
  resources.own(async () => {
    await connectedManager?.disconnectAllServers();
  });
  const elicitationBridge = elicitationEnabled
    ? new HostedElicitationBridge({
        convexBearer: convexBearer!,
        projectId: hostedBody.projectId,
        chatSessionId: hostedBody.chatSessionId,
        serverNamesById:
          buildServerNamesById(effectiveServerIds, effectiveServerNames) ?? {},
        abortSignal: c.req.raw.signal as AbortSignal | undefined,
      })
    : undefined;
  resources.own(async () => {
    await elicitationBridge?.dispose();
  });

  const harnessInput =
    elicitationBridge &&
    resolvedExecution.harness === "claude-code" &&
    rawBody.hostedHarnessInputVersion === HOSTED_HARNESS_INPUT_VERSION &&
    process.env.HARNESS_NATIVE_FORWARDING === "true" &&
    turnRail === "hosted" &&
    hostId && !scenarioId && !rawBody.harnessExecutionTarget
      ? createHarnessInputHost({
          allowedServerIds: new Set(effectiveServerIds),
          modes: harnessElicitationModes(effectiveClientCapabilities),
          handle: elicitationBridge.callback,
          signal: c.req.raw.signal,
        })
      : undefined;

  const mrtrBridge =
    mrtrEnabled && convexBearer
      ? new HostedMrtrBridge({
          bearer: convexBearer,
          projectId: hostedBody.projectId,
          ...(hostedBody.chatSessionId
            ? { chatSessionId: hostedBody.chatSessionId }
            : {}),
          serverNamesById:
            buildServerNamesById(selectedServerIds, selectedServerNames) ?? {},
          authPrincipal: mrtrAuthPrincipal,
        })
      : undefined;

  // Delivery to the browser is a SEPARATE decision from whether tasks run.
  // A stale bundle that cannot render the part must not stop the host's
  // policy from taking effect — the task still gets created, it just isn't
  // pushed live. Absent or mismatched version ⇒ no bridge, and the turn
  // proceeds normally. Never a 409: see `HOSTED_TASKS_VERSION`.
  const taskCreatedBridge =
    tasksSeam &&
    isCompatibleHostedTasksVersion(
      (rawBody as Record<string, unknown>).hostedTasksVersion,
    )
      ? new HostedTaskCreatedBridge({
          requestedOwnerScope:
            typeof (rawBody as Record<string, unknown>).hostedTaskOwnerScope ===
            "string"
              ? ((rawBody as Record<string, unknown>)
                  .hostedTaskOwnerScope as string)
              : undefined,
          ownerRequestId: hostedTaskOwnerRequestId(
            (rawBody as Record<string, unknown>).hostedTaskOwnerRequestId,
            (rawBody as Record<string, unknown>).hostedTaskOwnerVersion,
          ),
          serverNamesById:
            buildServerNamesById(effectiveServerIds, effectiveServerNames) ??
            {},
        })
      : undefined;
  if (taskCreatedBridge) {
    // Functional, not best-effort: this is the path the user's next page
    // load depends on to know the task exists.
    tasksSink.register({
      name: "hosted-task-created-bridge",
      handle: taskCreatedBridge.handle,
    });
  }
  if (tasksSeam && convexBearer) {
    // Best-effort, and registered AFTER the bridge so the durable local
    // handle always lands first — a slow registry write can never cost the
    // user the thing they need to find the task again.
    //
    // Dark until the backend's owner-binding gate is switched on, at which
    // point this starts writing rows with no change here: the disabled state
    // answers with the same 404 envelope as "not deployed" and degrades to a
    // single log line.
    tasksSink.register({
      name: "hosted-task-registry",
      bestEffort: true,
      handle: (event) =>
        recordHostedTask(event, {
          bearer: convexBearer,
          projectId: hostedBody.projectId,
        }).then(() => undefined),
    });
  }

  let modelPluginAdmission:
    | import("../../services/plugin-host/admission.js").PluginWorkspaceAdmission
    | undefined;
  let modelPluginBearer: string | undefined;
  let modelPluginSubject: string | undefined;
  let modelToolExecutor:
    import("../../utils/model-tool-executor.js").ModelToolExecutor | undefined;
  let modelFormDispatch: ReturnType<typeof createModelFormDispatch> | undefined;
  let modelMrtr: ReturnType<typeof createModelMrtrAdapter> | undefined;
  // The client's OpenAI plugin extensions setting decides whether the OpenAI
  // form extensions are advertised or handled at all.
  // Emulated and Codex harness turns (whose MCP tools run here, in process)
  // take the same plugin executor; see `chatPluginFormPlan`.
  const hostPins = hostRuntimeConfig
    ? buildHostConnectionPins(hostRuntimeConfig, WEB_STREAM_TIMEOUT_MS)
    : undefined;
  const pluginPins =
    pluginWorkspace && turnMode === "interactive" ? hostPins : undefined;
  const pluginPinFor = (id: string) =>
    pluginPins?.mcpProtocolVersionsByServerId?.[id] ??
    pluginPins?.initializePins?.mcpProtocolVersion;
  const pluginFormPlan = pluginPins
    ? chatPluginFormPlan({
        harness: resolvedExecution.agentLoop
          ? undefined
          : resolvedExecution.harness,
        agentLoop: resolvedExecution.agentLoop,
        serverIds: effectiveServerIds,
        pinFor: pluginPinFor,
        mrtrEnabled,
        forms: pluginExtensions?.capabilities.forms,
      })
    : undefined;
  // Set once the turn's manager exists: an Auto server's era is the one its
  // connection negotiated.
  let pluginNegotiatedVersion: (serverId: string) => string | undefined = () =>
    undefined;
  if (pluginWorkspace && hostRuntimeConfig && pluginFormPlan?.admitted) {
    assertPluginWorkspaceRuntime({
      harness: resolvedExecution.agentLoop
        ? undefined
        : resolvedExecution.harness,
      agentLoop: resolvedExecution.agentLoop,
      hostPolicy: {
        hostStyle: hostRuntimeConfig.hostStyle as string | undefined,
      },
    });
    modelPluginBearer = await getConvexBearerForRequest(c);
    modelPluginSubject = toolApprovalSubjectFromAuthHeader(
      c.req.header("authorization"),
    );
    if (modelPluginSubject === "anonymous")
      throw new Error("Plugin model identity unavailable");
    modelPluginAdmission = await admitPluginWorkspace({
      descriptor: pluginWorkspace,
      projectId: hostedBody.projectId,
      bearer: modelPluginBearer,
      signal: c.req.raw.signal,
    });
    const hostId = hostRuntimeConfig.hostId;
    if (typeof hostId !== "string")
      throw new Error("Plugin model host unavailable");
    const { modernServerIds, legacyServerIds: eligibleServerIds } =
      pluginFormPlan;
    if (modernServerIds.length) {
      modelMrtr = createModelMrtrAdapter({
        c,
        admission: modelPluginAdmission,
        bearer: modelPluginBearer,
        identity: {
          actorId: modelPluginAdmission.actorId,
          projectId: modelPluginAdmission.projectId,
          workspaceId: modelPluginAdmission.workspaceId,
          subject: modelPluginSubject,
        },
        hostId,
        hostRevision: pluginHostBindingDigest(hostRuntimeConfig),
        serverIds: modernServerIds,
        modelVisibleMcpToolResults,
      });
    }
    // All of the turn's servers or none (shared connection capabilities).
    let legacyExecutor: typeof modelToolExecutor;
    if (eligibleServerIds.length) {
      modelFormDispatch = createModelFormDispatch(eligibleServerIds);
      legacyExecutor = createModelFormExecutor({
        c,
        admission: modelPluginAdmission,
        bearer: modelPluginBearer,
        identity: {
          actorId: modelPluginAdmission.actorId,
          projectId: modelPluginAdmission.projectId,
          workspaceId: modelPluginAdmission.workspaceId,
          subject: modelPluginSubject,
        },
        hostId,
        hostRevision: pluginHostBindingDigest(hostRuntimeConfig),
        serverIds: effectiveServerIds,
        eligibleServerIds,
        dispatch: modelFormDispatch,
      });
    }
    // An Auto server is in both plans; each call follows its negotiated era.
    modelToolExecutor = chatPluginToolExecutor({
      ...(modelMrtr
        ? { modern: { serverIds: modernServerIds, execute: modelMrtr.execute } }
        : {}),
      legacy: legacyExecutor,
      pinFor: pluginPinFor,
      negotiatedVersion: (serverId) => pluginNegotiatedVersion(serverId),
      onFailure: (execution, error) => {
        // Suspensions are control flow. Stable host errors are diagnostics,
        // never fabricated tools/call responses or raw upstream payloads.
        if (!(error instanceof PluginInvocationError)) return;
        rpcCollector?.rpcLogger({
          direction: "receive",
          serverId: execution.serverKey,
          message: {
            jsonrpc: "2.0",
            method: `plugin-extensions/${error.code}`,
            params: {
              level: "error",
              code: error.code,
              description: describePluginError(error.code) ?? error.code,
              outcomeUnknown: error.outcomeUnknown,
            },
          },
        });
      },
    });
  }

  const isolatedServerIds = chatTurnIsolatedServerIds(
    effectiveServerIds,
    turnMode,
  );
  // Membership chat (no share/scenario token) is the default — the backend
  // authorizes via project ownership for both guest and authed users.
  // accessScope is only set when a token is in play (shared chat / scenario)
  // since that's an orthogonal access path keyed on the token, not the actor.
  const {
    manager,
    oauthServerUrls: urls,
    authenticatedUserId,
    refusedServers,
  } = await createAuthorizedManager(
    callerContextFromHono(c),
    bearerToken,
    hostedBody.projectId,
    effectiveServerIds,
    hostPins?.timeoutMs ?? WEB_STREAM_TIMEOUT_MS,
    hostedBody.oauthTokens,
    // Scenario: advertise the HOST's capabilities, not the body's, so the
    // wire matches what we're prepared to honor.
    // OpenAI form extensions are claimed only with a handler installed.
    installedFormClientCapabilities(
      effectiveClientCapabilities && pluginExtensions
        ? applyPluginExtensionsToClientCapabilities(
            effectiveClientCapabilities,
            pluginExtensions,
          )
        : effectiveClientCapabilities,
      // An Auto server's MRTR answers standard elicitation; only a pinned
      // modern server keeps OpenAI's claim for MRTR (unchanged by Auto).
      {
        ...(modelFormDispatch
          ? { legacy: { binding: modelFormDispatch.handlers } }
          : {}),
        mrtr:
          !!modelMrtr &&
          effectiveServerIds.some((id) => pluginPinFor(id) === "2026-07-28"),
      },
      pluginExtensions?.capabilities.forms,
    ),
    {
      multiConnection: true,
      tolerateServerRefusals: isolatedServerIds,
      ...(modelFormDispatch
        ? { extensionRequestHandlers: modelFormDispatch.handlers }
        : {}),
      ...(turnMode === "recorded" ? { accessScope: "chat_v2" } : {}),
      scenarioId,
      accessVersion,
      rpcLogger: rpcCollector.rpcLogger,
      httpLogger: rpcCollector.httpLogger,
      serverNames: effectiveServerNames,
      initializePins: effectiveInitializePins,
      requestTimeoutByServerId: hostPins?.requestTimeoutByServerId,
      mcpProtocolVersionsByServerId,
      xaaPolicy,
      // Required for any XAA server in the batch (policy-forced or
      // per-server configured) — without it the builder 500s rather than
      // connecting tokenless.
      xaaIssuer: resolveXaaIssuer(c, HOSTED_MODE),
      ...(elicitationBridge
        ? {
            elicitationCallback: elicitationBridge.callback,
            elicitationTimeoutExtensionMs: ELICITATION_TIMEOUT_EXTENSION_MS,
          }
        : {}),
      // Registered SYNCHRONOUSLY inside createAuthorizedManager (before the
      // connect microtask) so `buildCapabilities` advertises `elicitation`
      // for MRTR-capable servers — same race discipline as elicitation.
      ...(mrtrBridge || harnessInput
        ? {
            mrtrInputCollectorForServer: (
              serverId: string,
              organizationId?: string | null,
            ) =>
              modelMrtr?.collectorForServer(serverId) ??
              mrtrBridge?.mrtrInputCollectorForServer(serverId) ??
              (isForwardingOrganization(organizationId)
                ? harnessInput?.collectMrtrForServer(serverId)
                : undefined),
          }
        : {}),
      // Same scope the bash tool reserves under, so a plugin's stdio
      // component colocates into THIS turn's machine rather than waking the
      // member's personal one alongside it.
      ...(executionScope ? { executionScope } : {}),
    },
  );
  if (typeof hostRuntimeConfig?.hostConfigId === "string") setManagerResourceHostConfig(manager, hostRuntimeConfig.hostConfigId);
  connectedManager = manager;
  taskCreatedBridge?.bindOwner(hostedBody.projectId, authenticatedUserId);
  const pendingApproval = pendingStdioCommandApproval(refusedServers);
  if (pendingApproval) throw pendingApproval;
  if (Array.isArray(hostedBody.messages) && hostedBody.messages.length <= 1)
    void refreshConnectionProfiles(manager, bearerToken, hostedBody.projectId);

  onOAuthServerUrls(urls);
  pluginNegotiatedVersion = (serverId) =>
    manager.getInitializationInfo(serverId)?.protocolVersion;
  // Inject the live manager so the collector's fingerprint/era thunks can
  // read the negotiated identity at suspend time (post-connect).
  mrtrBridge?.setManager(manager);

  // Build the engine resume descriptor: on a fresh resume request the engine
  // drives one retry leg (with reconstructed output-schema validation) before
  // the first model call and splices the result. `resolve` closes over the
  // freshly-authorized manager for the bound server.
  const mrtrEngineResume: MrtrEngineResume | undefined =
    mrtrResumeRequest?.owned
      ? {
          toolCallId: mrtrResumeRequest.toolCallId,
          resolve: async (emit) => {
            if (!modelMrtr)
              throw new Error("Original model continuation unavailable");
            modelMrtr.attachStreamWriter({ write: emit });
            return modelMrtr.resume(
              mrtrResumeRequest.owned!,
              mrtrResumeRequest.owned!.submission,
              mrtrResumeRequest.serverId,
            );
          },
        }
      : mrtrResumeRequest && convexBearer
        ? {
            toolCallId: mrtrResumeRequest.toolCallId,
            resolve: (emit) =>
              resolveMrtrChatResume({
                manager,
                bearer: convexBearer,
                serverId: mrtrResumeRequest.serverId,
                ...(buildServerNamesById(
                  selectedServerIds,
                  selectedServerNames,
                )?.[mrtrResumeRequest.serverId]
                  ? {
                      serverName: buildServerNamesById(
                        selectedServerIds,
                        selectedServerNames,
                      )![mrtrResumeRequest.serverId],
                    }
                  : {}),
                toolCallId: mrtrResumeRequest.toolCallId,
                submission: {
                  continuationId: mrtrResumeRequest.continuationId,
                  round: mrtrResumeRequest.round,
                  responses: mrtrResumeRequest.responses!,
                },
                authPrincipal: mrtrAuthPrincipal,
                ...(modelVisibleMcpToolResults
                  ? { modelVisibleMcpToolResults }
                  : {}),
                emit,
              }),
          }
        : undefined;

  // SEP-1865 App-Provided Tools: validate the client snapshot at the
  // boundary. Oversize / malformed entries 400 with a clean message
  // before prepareChatV2 ever sees them.
  let validatedAppTools;
  try {
    validatedAppTools = validateAppToolEntries(body.appTools);
  } catch (error) {
    if (error instanceof AppToolValidationError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    throw error;
  }

  // WebMCP page tools: same boundary treatment as the app-tool snapshot, and
  // gated on the inspector's kill switch: a turn must not advertise the
  // tools of a page this deployment cannot drive, because the model would
  // call one and the client would have no session to fulfil it with.
  let validatedPageTools: PageToolEntry[];
  try {
    validatedPageTools = WEBMCP_INSPECTOR_ENABLED
      ? validatePageToolEntries(body.pageTools)
      : [];
  } catch (error) {
    if (error instanceof PageToolValidationError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    throw error;
  }

  // `body.uiTools` is intentionally ignored here, not rejected: MCPJam UI
  // tools are agent-route-only (server/routes/web/mcpjam-agent.ts), but
  // cached pre-cutover clients may still send the field. MCP server tools
  // whose names happen to match `ui_*` come from MCPClientManager and stay
  // ordinary executable tools.

  let validatedWidgetModelContext;
  try {
    validatedWidgetModelContext = validateWidgetModelContextEntries(
      body.widgetModelContext,
    );
  } catch (error) {
    if (error instanceof WidgetModelContextValidationError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    throw error;
  }

  return {
    tasksSeam,
    harnessOwnedInput: !!harnessInput,
    scopeStepUpResumeRequest,
    scopeStepUpCancelRequest,
    scopeStepUpEnabled,
    convexBearer,
    mrtrAuthPrincipal,
    elicitationBridge,
    mrtrBridge,
    taskCreatedBridge,
    modelPluginAdmission,
    modelPluginBearer,
    modelPluginSubject,
    modelToolExecutor,
    modelMrtr,
    isolatedServerIds,
    manager,
    authenticatedUserId,
    refusedServers,
    mrtrEngineResume,
    validatedAppTools,
    validatedPageTools,
    validatedWidgetModelContext,
  };
}
