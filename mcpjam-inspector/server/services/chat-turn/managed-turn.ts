import { resolveManagedTurnSetup } from "./managed-setup.js";
import { prepareManagedConnections } from "./managed-connections.js";
import { prepareManagedTools } from "./managed-tools.js";
import { TurnResources } from "./resources.js";
import { stripForwardingRequestBody } from "@/shared/forwarding-approval";
import { preparePluginMessageTurn } from "../plugin-host/message.js";
import {
  readOwnedTurnContext,
  pluginContextReferencesSchema,
} from "../plugin-host/turn-context.js";
import { pluginChatRefusal } from "../../routes/web/chat-v2-plugin-refusal.js";
import {
  globalOwnerAdmission,
  mergePluginContextMessages,
  withGlobalOwnerFallback,
} from "../../routes/web/chat-v2-global-owner.js";
import { toResumeExecutionTarget } from "@/shared/execution-target";
import { toMintedPageToolRecords } from "@/shared/declared-tools";
import { type Context } from "hono";
import { isMCPAuthError } from "@mcpjam/sdk";
import { advertisedPageToolsOnly } from "../../utils/chat-v2-orchestration.js";
import { buildDirectHostConfig } from "../../utils/chat-ingestion.js";
import { streamWebChatTurn } from "../../utils/web-chat-turn.js";
import { captureServerEvent } from "../../utils/analytics.js";
import {
  assertBearerToken,
  readJsonBody,
  ErrorCode,
  webError,
  webErrorFromRoute,
  mapTargetServerError,
  projectRouteFailure,
} from "../../routes/web/auth.js";
import { createHostedRpcLogCollector } from "../../routes/web/hosted-rpc-logs.js";
import { getSpendClientIp } from "../../utils/client-ip.js";
import { toolCallCancellationFromMcpProfile } from "../../utils/effective-auth.js";
import { harnessSupportsSkills } from "../../utils/harness/registry.js";
import { runtimeServersAreOverridden } from "../environments/runtime.js";
import { withLiveProjectSkills } from "../environments/effective-capabilities.js";
import { type HarnessBox } from "../../utils/harness/harness-box.js";
import { logger } from "../../utils/logger.js";

export async function handleManagedChatTurn(c: Context): Promise<Response> {
  // NOTE: This route does NOT use handleRoute() because handleMCPJamFreeChatModel
  // returns a streaming Response. Wrapping it in handleRoute → c.json() would
  let oauthServerUrls: Record<string, string> = {};
  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  // The scenario conversation's disposable box, held for this turn: its
  // heartbeat runs until the turn's stream completes, or until a throw below.
  // Releasing it never tears the box down — the next turn reattaches to it.
  let scenarioBox: HarnessBox | undefined;
  const resources = new TurnResources((error) => {
    logger.warn("[chat-v2] turn resource cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  let streamOwnsResources = false;
  let managerToDispose: { disconnectAllServers(): Promise<void> } | undefined;
  // Boxes may be assigned during setup, before a manager exists.
  resources.own(async () => {
    await scenarioBox?.release();
  });
  resources.own(async () => {
    await managerToDispose?.disconnectAllServers();
  });
  try {
    const bearerToken = assertBearerToken(c);
    const rawBody = JSON.parse(
      stripForwardingRequestBody(
        JSON.stringify(await readJsonBody<Record<string, unknown>>(c)),
      ),
    ) as Record<string, unknown>;
    if (
      rawBody.browserEngine === "local" ||
      c.req.header("x-mcpjam-browser-consent")
    ) {
      return c.json(
        {
          error: "Local Browser must use the local Inspector chat route",
          code: "browser_location_mismatch",
        },
        409,
      );
    }
    rpcCollector = createHostedRpcLogCollector(rawBody);

    // ── Convex authorization path: guest and signed-in actors ─────
    const setup = await resolveManagedTurnSetup({
      c,
      rawBody,
      bearerToken,
      rpcCollector,
    });
    if (!setup.value) return setup.response;
    let {
      hostedBody,
      initializePins,
      mcpProtocolVersionsByServerId,
      body,
      messages,
      bodyTemperature,
      scenarioId,
      accessVersion,
      surface,
      hostId,
      executionTarget,
      modelDefinition,
      turnMode,
      hostRuntimeConfig,
      environmentSpec,
      scenarioEnvironment,
      authoritativeConnectionPolicy,
      pinsEnvironment,
      effectiveCapabilities,
      effectiveServerIds,
      effectiveServerNames,
      environmentSkills,
      xaaPolicy,
      resolvedExecution,
      turnProvenance,
      externalAccountHarnessTurn,
      selected,
      routingSelection,
      temperature,
      systemPrompt,
      bodyEffort,
      reasoningEffort,
      requireToolApproval,
      respectToolVisibility,
      resolvedProgressiveToolDiscovery,
      modelVisibleMcpToolResults,
      mcpToolResultImageRendering,
      harnessExecutionTarget,
      executionScope,
      scenarioParticipant,
      harnessComputerWorkdir,
      includeProjectSkills,
      liveProjectCapabilities,
      projectSkillReadFailed,
    } = setup.value;
    const connections = await prepareManagedConnections({
      c,
      rawBody,
      bearerToken,
      rpcCollector,
      resources,
      setup: setup.value,
      onOAuthServerUrls: (urls) => {
        oauthServerUrls = urls;
      },
      onManager: (manager) => {
        managerToDispose = manager;
      },
    });
    let {
      tasksSeam,
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
    } = connections;
    const toolsState = await prepareManagedTools({
      c,
      bearerToken,
      setup: setup.value,
      connections,
      state: {
        get scenarioBox() {
          return scenarioBox;
        },
        set scenarioBox(value) {
          scenarioBox = value;
        },
      },
    });
    let {
      runtimeSecrets,
      secretsUnavailable,
      markSecretsDelivered,
      sandboxNotices,
      ackSandboxNotices,
      pageToolsSnapshot,
      builtInTools,
      effectiveSystemPrompt,
    } = toolsState;
    try {
      const sourceType = turnMode === "recorded" ? "scenario" : "direct";
      // Mirrors the sourceType branch — scenario surface stays "scenario", the
      // non-scenario case is the inspector playground. The docs agent has its
      // own route (mcpjam-agent.ts) and never lands here.
      const origin = turnMode === "recorded" ? "scenario" : "playground";
      const isDirectChat = turnMode === "interactive";
      // The turn's servers minus the ones a plugin contributed, for the
      // trace's host config (see where it is built below).
      const pluginServerIdSet = new Set(
        effectiveCapabilities?.pluginServerIds ?? [],
      );
      const hostConfigServerIds = effectiveServerIds.filter(
        (serverId) => !pluginServerIdSet.has(serverId),
      );

      // Server twin of the client's `send_message` — fires even when the
      // browser can't reach PostHog. Identity: guests always resolve (the
      const skillDelivery = environmentSpec
        ? resolvedExecution.harness
          ? harnessSupportsSkills(resolvedExecution.harness)
            ? "harness"
            : "harness_unsupported"
          : "emulated"
        : undefined;
      captureServerEvent(c, "send_message_server", {
        origin,
        source_type: sourceType,
        ...(environmentSpec
          ? {
              environment_id: environmentSpec.environmentRef.environmentId,
              environment_name: environmentSpec.environmentRef.name,
              environment_revision: environmentSpec.environmentRef.revision,
              environment_host_id: environmentSpec.host.hostId,
              environment_host_config_id:
                environmentSpec.host.hostConfigId ?? null,
              environment_overridden:
                runtimeServersAreOverridden(environmentSpec),
              environment_base_server_count:
                environmentSpec.servers.baseEffectiveServerIds?.length ??
                environmentSpec.servers.effectiveServerIds.length,
              environment_effective_server_count: effectiveServerIds.length,
              environment_skill_count: environmentSkills?.length ?? 0,
              environment_skill_delivery: skillDelivery,
              environment_plugin_version_ids: (
                environmentSpec.pluginVersions ?? []
              ).map((plugin) => plugin.pluginVersionId),
              // INS-3 provenance. Bundle hashes are content addresses, not
              // user data, and are what makes a run attributable to an exact
              environment_plugin_bundle_hashes: (
                environmentSpec.pluginVersions ?? []
              ).map((plugin) => plugin.bundleHash ?? null),
              environment_plugin_server_count:
                effectiveCapabilities?.pluginServerIds.length ?? 0,
              environment_plugin_skill_count:
                effectiveCapabilities?.pluginSkills.length ?? 0,
              environment_capability_problems: (
                effectiveCapabilities?.problems ?? []
              ).map((problem) => problem.code),
              // The Playground's hidden environment (a client turn carrying
              // its project's plugins), not one a member chose.
              ...(includeProjectSkills ? { environment_hidden: true } : {}),
            }
          : {}),
        // Environment-BACKED SCENARIO turn (live-follow). A deliberately
        // smaller slice than the environment-target block above: the payload
        ...(scenarioEnvironment
          ? {
              scenario_environment_backed: true,
              environment_id: scenarioEnvironment.environmentRef.environmentId,
              environment_revision: scenarioEnvironment.environmentRef.revision,
              environment_effective_server_count: effectiveServerIds.length,
              environment_skill_count: environmentSkills?.length ?? 0,
            }
          : {}),
      });

      const contextReferences = pluginContextReferencesSchema.parse(
        body.pluginContextReferences ?? [],
      );
      const globalContextReferences = pluginContextReferencesSchema.parse(
        body.pluginGlobalContextReferences ?? [],
      );
      // Global Apps live in their own workspace and bind to this chat's turn.
      const globalPluginAdmission = globalOwnerAdmission(
        modelPluginAdmission,
        body.pluginGlobalWorkspace,
      );
      if (
        (contextReferences.length || globalContextReferences.length) &&
        (!modelPluginAdmission || !modelPluginBearer || !modelPluginSubject)
      )
        throw new Error("App context unavailable for this chat");
      const readTurnContext = (
        references: string[],
        admission: NonNullable<typeof modelPluginAdmission>,
      ) =>
        readOwnedTurnContext({
          c,
          references,
          admission,
          bearer: modelPluginBearer!,
          actor: {
            actorId: admission.actorId,
            projectId: admission.projectId,
            workspaceId: admission.workspaceId,
            subject: modelPluginSubject!,
          },
        });
      const pluginContext = mergePluginContextMessages(
        contextReferences.length
          ? await readTurnContext(contextReferences, modelPluginAdmission!)
          : undefined,
        globalContextReferences.length && globalPluginAdmission
          ? await readTurnContext(
              globalContextReferences,
              globalPluginAdmission,
            )
          : undefined,
      );
      const appMessages = await withGlobalOwnerFallback(
        (admission) =>
          preparePluginMessageTurn({
            c,
            intent: body.pluginMessage,
            messages: messages as import("ai").UIMessage[],
            hostId:
              typeof hostRuntimeConfig?.hostId === "string"
                ? hostRuntimeConfig.hostId
                : undefined,
            serverIds: effectiveServerIds,
            threadId: body.chatSessionId,
            admission,
            bearer: modelPluginBearer,
          }),
        modelPluginAdmission,
        body.pluginMessage === undefined ? undefined : globalPluginAdmission,
      );
      const response = await streamWebChatTurn({
        manager,
        prepare: {
          ...(modelToolExecutor ? { modelToolExecutor } : {}),
          selectedServerIds: effectiveServerIds,
          modelDefinition,
          ...(routingSelection
            ? { routingSelection, routingSelectionOrigin: selected.origin }
            : {}),
          systemPrompt: effectiveSystemPrompt,
          temperature,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
          // Only a temperature sent ALONGSIDE a body effort counts as
          // explicit: a host default (or the slider value a client sends with
          ...(turnMode === "interactive" &&
          bodyEffort.effort !== undefined &&
          bodyTemperature !== undefined
            ? { explicitTemperature: bodyTemperature }
            : {}),
          requireToolApproval,
          respectToolVisibility,
          modelVisibleMcpToolResults,
          // Server-resolved, never from the body, and authoritative whenever a
          // host config resolved: an EMPTY record means "cancels normally" and
          ...(hostRuntimeConfig
            ? {
                toolCallCancellation:
                  toolCallCancellationFromMcpProfile(
                    (hostRuntimeConfig as { mcpProfile?: unknown }).mcpProfile,
                  ) ?? {},
              }
            : {}),
          customProviders: body.customProviders,
          uiMessages: appMessages,
          ...(pluginContext ? { pluginContext } : {}),
          ...(resolvedExecution.harness
            ? {
                harness: resolvedExecution.harness,
                agentLoop: resolvedExecution.agentLoop,
                ...(harnessExecutionTarget ? { harnessExecutionTarget } : {}),
              }
            : {}),
          ...(tasksSeam ? { tasks: tasksSeam } : {}),
          ...(resolvedProgressiveToolDiscovery !== undefined
            ? {
                progressiveToolDiscovery: {
                  enabled: resolvedProgressiveToolDiscovery,
                },
              }
            : {}),
          appTools: validatedAppTools,
          pageTools: validatedPageTools,
          widgetModelContext: validatedWidgetModelContext,
          ...(builtInTools ? { builtInTools } : {}),
          // GROW THE TOOL SET AS THE PAGE CHANGES. The model navigates on one
          // step and the tools it needs exist only from the next; a
          onPageToolNamesReserved: (reserved) => {
            toolsState.reservedAgainstPageTools = reserved;
          },
          ...(toolsState.pageToolRefresh
            ? {
                refreshTools: async (ctx: { signal?: AbortSignal }) => {
                  const refresh =
                    await toolsState.pageToolRefresh!.refreshPageTools(ctx);
                  toolsState.advertisedPageTools =
                    toolsState.pageToolRefresh!.currentPageTools();
                  toolsState.advertisedPageToolsBinding =
                    toolsState.pageToolRefresh!.currentPageToolsBinding();
                  return refresh as never;
                },
              }
            : {}),
          // COMP-16: root the harness Shell at the host-configured working
          // directory — the same `computer.workdir` the bash tool runs in.
          ...(harnessComputerWorkdir
            ? { computerWorkdir: harnessComputerWorkdir }
            : {}),
          // The project's skills as a capability set, for a target that
          // resolves no environment (host / adhoc). Same gate as before, same
          ...(liveProjectCapabilities && !effectiveCapabilities
            ? {
                effectiveCapabilities: liveProjectCapabilities,
                liveSkillSurface: true,
              }
            : {}),
          // Emulated-engine delivery of the environment's resolved skills.
          // Mutually exclusive with the live set above (gated on the same
          ...(environmentSkills !== undefined
            ? { runtimeSkillsOverride: environmentSkills }
            : {}),
          // A hidden environment adds the project's pool after its own union,
          // and is a LIVE surface like the client turn it stands in for: its
          ...(effectiveCapabilities && liveProjectCapabilities
            ? {
                effectiveCapabilities: withLiveProjectSkills(
                  effectiveCapabilities,
                  liveProjectCapabilities,
                ),
                liveSkillSurface: true,
              }
            : effectiveCapabilities
              ? { effectiveCapabilities }
              : {}),
          isolatedServers: {
            serverIds: isolatedServerIds,
            refused: refusedServers,
          },
        },
        persist: {
          executionBindingVersion: resolvedExecution.executionBindingVersion,
          executionTarget: toResumeExecutionTarget(executionTarget),
          chatSessionId: body.chatSessionId,
          projectId: hostedBody.projectId,
          sourceType,
          origin,
          ...(turnMode === "recorded" && surface ? { surface } : {}),
          scenarioId,
          accessVersion,
          // Phase 3: forward the runtime-config scope into the harness path
          // (alongside the bash-tool path threaded above).
          ...(executionScope ? { executionScope } : {}),
          // The conversation's box: its binding for a harness turn, and its
          // heartbeat to stop when the turn's stream completes.
          ...(scenarioBox ? { scenarioBox } : {}),
          ...(scenarioParticipant ? { scenarioParticipant: true } : {}),
          authenticatedUserId,
          ...(hostId ? { hostId } : {}),
          originalMessages: messages,
          ...(resolvedExecution.harness
            ? {
                harness: resolvedExecution.harness,
                agentLoop: resolvedExecution.agentLoop,
                ...(harnessExecutionTarget ? { harnessExecutionTarget } : {}),
              }
            : {}),
          // Harness-engine delivery of the environment's resolved skills.
          // Presence (even empty) is what makes it authoritative downstream.
          ...(environmentSkills !== undefined
            ? { runtimeSkillsOverride: environmentSkills }
            : {}),
          // The Playground's hidden environment on a harness: the harness adds
          // the project's live pool to the environment's own skills, as the
          ...(includeProjectSkills && resolvedExecution.harness
            ? { includeProjectSkills: true }
            : {}),
          ...(turnProvenance ? { turnProvenance } : {}),
          ...(environmentSpec ? { setupEnvironment: environmentSpec } : {}),
          setupSkillProvenanceIncomplete: projectSkillReadFailed,
          // Arbitrary client-info fields cannot safely be hashed as provenance.
          setupConnectionPolicyIncomplete:
            initializePins !== undefined ||
            mcpProtocolVersionsByServerId !== undefined ||
            (!authoritativeConnectionPolicy && xaaPolicy != null),
          // WHAT THIS TURN ACTUALLY ADVERTISED from the page. Written down
          // rather than re-derived, so a reopened conversation shows the tools
          ...(pageToolsSnapshot || toolsState.pageToolRefresh
            ? {
                pageToolsAtTurn: () =>
                  toMintedPageToolRecords(
                    // Filtered by the same collision policy the model's set
                    // was, so the record cannot name a tool the model was
                    // never actually offered.
                    toolsState.reservedAgainstPageTools
                      ? advertisedPageToolsOnly(
                          toolsState.advertisedPageTools,
                          toolsState.reservedAgainstPageTools,
                        )
                      : toolsState.advertisedPageTools,
                    toolsState.advertisedPageToolsBinding ?? pageToolsSnapshot,
                  ),
              }
            : {}),
          // INS-7: the same resolution, unflattened, for Computer delivery —
          // supporting files (the flat list drops them, and the project-wide
          ...(effectiveCapabilities ? { effectiveCapabilities } : {}),
          // PROJECT SECRETS: the id only, never the resolved spec. The harness
          // turn fetches this environment's materialized secrets from Convex
          ...(environmentSpec && (pinsEnvironment || externalAccountHarnessTurn)
            ? {
                environmentId: environmentSpec.environmentRef.environmentId,
                persistEnvironmentPin: pinsEnvironment,
              }
            : {}),
          // Already resolved above, so the turn helper does not re-fetch:
          // presence is semantic, and one fetch is what keeps the scrubber's
          // registry and the box's environment describing the same set.
          ...(runtimeSecrets !== null ? { runtimeSecrets } : {}),
          // Distinguishes "there are none" from "we could not find out". Only
          // the second forks the session — see the fetch site above.
          ...(secretsUnavailable ? { secretsUnavailable: true } : {}),
          ...(markSecretsDelivered
            ? { onSecretEnvDelivered: markSecretsDelivered }
            : {}),
          ...(isDirectChat ? { directVisibility: body.directVisibility } : {}),
          ...(isDirectChat && body.rewind ? { rewind: body.rewind } : {}),
          // Hosted sessions finally honor the CAS the client already sends.
          // Read from the SCHEMA-VALIDATED body, not the raw cast one.
          ...(hostedBody.expectedVersion !== undefined
            ? { expectedVersion: hostedBody.expectedVersion }
            : {}),
          // Closure receives `resolvedTemperature` from inside the helper,
          // preserving the legacy behavior where chat-v2 fed the post-
          // prepare resolved temperature into `buildDirectHostConfig`.
          hostConfig: isDirectChat
            ? ({ resolvedTemperature }) =>
                buildDirectHostConfig({
                  modelId: String(modelDefinition.id),
                  // Phase 3: real host style flows from the chat tab; old
                  // inspector builds omit it and the backend defaults to
                  // 'claude' (no more legacy 'direct' hostStyle in new traces).
                  hostStyle: body.hostStyle,
                  systemPrompt,
                  requestedTemperature: temperature,
                  resolvedTemperature,
                  requireToolApproval,
                  respectToolVisibility,
                  modelVisibleMcpToolResults:
                    resolvedExecution.modelVisibleMcpToolResults,
                  mcpToolResultImageRendering:
                    resolvedExecution.mcpToolResultImageRendering,
                  // Plugin servers stay out: ingestion's server-scope check
                  // refuses a plugin id in a host config (lifecycle bypass),
                  // and would drop the trace's whole host config with it.
                  selectedServerIds: hostConfigServerIds,
                })
            : null,
          selectedServerNames: effectiveServerNames,
          selectedServerIds: effectiveServerIds,
          // Plugin-contributed servers ran this turn but are never written
          // into the durable resume instruction: a plugin's membership is
          ...(effectiveCapabilities &&
          effectiveCapabilities.pluginServerIds.length > 0
            ? { nonResumableServerIds: effectiveCapabilities.pluginServerIds }
            : {}),
          // Persisted resume config keeps the RAW user prompt; the blueprint
          // env block is turn-injected (added to `prepare` above), not user
          systemPrompt,
          temperature,
          requireToolApproval,
          mcpToolResultImageRendering,
          respectToolVisibility,
        },
        runtime: {
          authHeader: c.req.header("authorization"),
          clientIp: getSpendClientIp(c),
          abortSignal: c.req.raw.signal as AbortSignal | undefined,
          rpcCollector,
          elicitationBridge,
          // One-time sandbox notices PEEKED from the control plane above (the
          // stream writer doesn't exist yet at provision time). Flushed once
          ...(sandboxNotices ? { sandboxNotices } : {}),
          ...(ackSandboxNotices ? { ackSandboxNotices } : {}),
          ...(mrtrBridge ? { mrtrBridge } : {}),
          ...(modelMrtr ? { modelFormBridge: modelMrtr } : {}),
          ...(taskCreatedBridge ? { taskCreatedBridge } : {}),
          ...(mrtrEngineResume ? { mrtrResume: mrtrEngineResume } : {}),
          ...(scopeStepUpEnabled && convexBearer
            ? {
                scopeStepUp: {
                  bearer: convexBearer,
                  authPrincipal: mrtrAuthPrincipal,
                  ...(scopeStepUpResumeRequest
                    ? { resumeRequest: scopeStepUpResumeRequest }
                    : {}),
                  ...(scopeStepUpCancelRequest
                    ? { cancelRequest: scopeStepUpCancelRequest }
                    : {}),
                },
              }
            : {}),
          c,
          dispose: () => resources.dispose(),
        },
      });
      streamOwnsResources = true;
      return resources.response(response, c.req.raw.signal);
    } catch (error) {
      // The bridge can hold rows created before the throw (e.g. an elicitation
      // during a tool call that then failed); withdraw them so no answerable
      // prompt outlives the turn.
      await resources.dispose();
      throw error;
    }
  } catch (error) {
    await resources.dispose();
    // Enrich MCPAuthError with OAuth server URL so the client can initiate OAuth
    if (isMCPAuthError(error) && Object.keys(oauthServerUrls).length > 0) {
      const firstUrl = Object.values(oauthServerUrls)[0];
      const msg = error instanceof Error ? error.message : String(error);
      return webError(
        c,
        401,
        ErrorCode.UNAUTHORIZED,
        msg,
        {
          oauthRequired: true,
          serverUrl: firstUrl,
        },
        rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
      );
    }
    const pluginRefusal = pluginChatRefusal(error);
    if (pluginRefusal)
      return webError(
        c,
        pluginRefusal.status,
        pluginRefusal.code,
        pluginRefusal.message,
        pluginRefusal.details,
      );
    // `webErrorFromRoute`, not `webError` — this call dropped
    // `routeError.normalized`, so the envelope carried no `origin` and no
    const routeError = mapTargetServerError(error);
    const envelope = rpcCollector?.buildEnvelope() as
      Record<string, unknown> | undefined;
    const projected =
      routeError.code === ErrorCode.UPSTREAM_HTTP_ERROR
        ? projectRouteFailure(routeError, error, envelope)
        : { routeError, logs: envelope };
    return webErrorFromRoute(c, projected.routeError, projected.logs);
  } finally {
    if (!streamOwnsResources) await resources.dispose();
  }
}
